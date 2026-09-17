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
  getLatestSessionWindow,
} from '@fno/shared';
import type { Exchange, Instrument, OptionChain, OptionChainStrike, OptionChainLeg, OptionType } from '@fno/shared';
import {
  calculatePCR,
  calculateMaxPain,
  calculateExpectedMove,
  classifyOptionOI,
  calculateIV,
  blackScholesPrice,
  calculateGreeksFromPrice,
  analyzePositionMomentum,
  analyzeOiTrap,
  analyzeTimeDecay,
  calculateGammaExposure,
} from '@fno/analytics';
import type { MarketDataProvider } from '../providers/interface.js';
import { computeChangeOiDetailed } from '../lib/oi-baseline.js';
import type { ChangeOiResult } from '../lib/oi-baseline.js';
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

  // A narrower window is a DISPLAY choice, not a different chain. Building
  // it as its own chain computed PCR, max pain and OI momentum over only
  // those strikes, so one page showed PCR 0.96 in the ±10 option chain
  // panel and 1.11 in Market Intelligence (the default ±20, which is also
  // what the bias votes on). Build the default chain — shared cache with
  // the bias engine — and trim only the strike rows.
  if (strikeRange < DEFAULT_STRIKE_RANGE) {
    const full = await buildOptionChain(provider, underlying, exchange, requestedExpiry, { strikeRange: DEFAULT_STRIKE_RANGE });
    return { ...full, strikes: sliceStrikesAroundAtm(full.strikes, full.atmStrike, strikeRange) };
  }

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

  const instruments = await provider.getInstrumentMaster();
  const contractsFor = (forExpiry: string) =>
    instruments.filter(
      (i) =>
        i.underlying === underlying &&
        i.exchange === exchange &&
        (i.instrumentType === 'OPTIDX' || i.instrumentType === 'OPTSTK' || i.instrumentType === 'OPTFUT') &&
        i.expiry === forExpiry &&
        i.strike !== undefined
    );

  // Belt and braces alongside the provider's option-only expiry list: pick the
  // nearest expiry that actually has contracts, so one odd entry can't take
  // the whole chain down (it did for CRUDEOIL on 17 Sep).
  const expiry =
    requestedExpiry && availableExpiries.includes(requestedExpiry) && contractsFor(requestedExpiry).length > 0
      ? requestedExpiry
      : availableExpiries.find((e) => contractsFor(e).length > 0) ?? availableExpiries[0];

  const { ltp: spotPrice, close: spotClose } = await getSpotQuote(provider, underlying, exchange);

  // The underlying's own day move, on the same basis every leg's
  // `changePercent` uses (LTP vs previous close) — so the chain's OI reads
  // and the underlying figure shown beside them are measuring the same
  // window and can't appear to contradict each other.
  const underlyingChange = spotClose > 0 ? Math.round((spotPrice - spotClose) * 100) / 100 : null;
  const underlyingChangePercent =
    spotClose > 0 ? Math.round(((spotPrice - spotClose) / spotClose) * 10000) / 100 : null;

  if (spotPrice <= 0) {
    throw new Error(`Unable to resolve a live spot price for ${underlying}`);
  }

  const optionInstruments = contractsFor(expiry);

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
  const changeOiByToken = new Map<string, ChangeOiResult>();
  await Promise.all(
    allTokens.map(async (token) => {
      const oi = quoteByToken.get(token)?.oi;
      if (oi !== undefined) changeOiByToken.set(token, await computeChangeOiDetailed(token, oi, exchange));
    })
  );

  const dte = calculateDTE(expiry);
  const tte = yearsToExpiry(expiry, exchange);
  const now = Date.now();

  // Time context for ivPressure (see below): when the current quote was
  // struck (the session's close, if it's over), and how much option time
  // separates it from the previous close. The overnight/weekend gap counts
  // as at most one day of decay — calendar-time theta over a weekend would
  // make every Monday premium look "bid up".
  const latestSession = getLatestSessionWindow(exchange, now);
  const priorSession = latestSession ? getLatestSessionWindow(exchange, latestSession.open - 1) : null;
  const quoteTime = latestSession ? Math.min(now, latestSession.close) : now;
  const tteAtQuote = tte + Math.max(0, now - quoteTime) / YEAR_MS;
  const decayMs =
    latestSession && priorSession
      ? Math.max(0, quoteTime - latestSession.open) + Math.min(Math.max(0, latestSession.open - priorSession.close), DAY_MS)
      : DAY_MS;
  const tteAtPrevClose = tteAtQuote + decayMs / YEAR_MS;

  // Options price off the FORWARD, not spot, and the two don't move
  // together: on 16 Sep NIFTY spot closed +99 while the options' own forward
  // (and the future) moved only +60 as the basis compressed. Repricing with
  // the spot move overstated it, so every call read "written" and every put
  // "bought" at the same strike. Use the forward implied by put-call parity
  // at the strikes nearest ATM, at both the previous close and now, and hand
  // the model F·e^(−rT) so its own forward is exactly F. Falls back to spot
  // when parity can't be read (too few two-sided strikes).
  const nearAtmPairs = Array.from(byStrike.entries())
    .filter(([, e]) => e.call && e.put)
    .sort(([a], [b]) => Math.abs(a - atmStrike) - Math.abs(b - atmStrike))
    .slice(0, PARITY_STRIKES)
    .map(([strike, e]) => ({ strike, call: quoteByToken.get(e.call!.token), put: quoteByToken.get(e.put!.token) }));
  const forwardNow = impliedForward(nearAtmPairs.map((p) => ({ strike: p.strike, call: p.call?.ltp, put: p.put?.ltp })), tteAtQuote);
  const forwardPrev = impliedForward(nearAtmPairs.map((p) => ({ strike: p.strike, call: p.call?.close, put: p.put?.close })), tteAtPrevClose);
  const useForward = forwardNow != null && forwardPrev != null;
  const pricingSpotNow = useForward ? forwardNow * Math.exp(-RISK_FREE_RATE * tteAtQuote) : spotPrice;
  const pricingSpotPrev = useForward ? forwardPrev * Math.exp(-RISK_FREE_RATE * tteAtPrevClose) : spotClose;

  // Per-leg inputs the expiry-session adjustment below needs again.
  const pressureInputs = new Map<string, { prevPremium: number; prevIv: number; ltp: number }>();

  const buildLeg = (inst: Instrument, strike: number, optionType: OptionType): OptionChainLeg => {
    const quote = quoteByToken.get(inst.token);
    const broker = greeksByKey.get(`${strike}:${optionType}`);
    const oiRead = changeOiByToken.get(inst.token);
    const changeOi = oiRead?.changeOi ?? 0;
    const pressure =
      quote && pricingSpotPrev > 0
        ? ivPressure(quote.close, quote.ltp, pricingSpotPrev, pricingSpotNow, strike, optionType, tteAtPrevClose, tteAtQuote)
        : null;
    const pressurePct = pressure?.pct ?? null;
    if (pressure && quote) pressureInputs.set(inst.token, { prevPremium: quote.close, prevIv: pressure.prevIv, ltp: quote.ltp });
    // Same self-computed % change as underlyingChangePercent above — this
    // comment previously referred to a field that didn't actually exist,
    // which is how the chain ended up with no day-scale reading of the
    // underlying at all (see OptionChain.underlyingChangePercent). Computed
    // rather than taken from the provider's own percentChange field, which
    // OHLC-mode payloads don't always populate — this leg's OWN premium move, feeding
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
          // Solved against the parity-implied forward (in spot terms), not
          // index spot — the same basis error fixed for ivPressure above.
          // With spot, a call and a put at one strike resolved to different
          // IVs whenever the basis moved, and delta (which sizes Trade Setup
          // targets) was off by the basis.
          const calculated = calculateGreeksFromPrice(quote?.ltp ?? 0, pricingSpotNow, strike, tteAtQuote, optionType, RISK_FREE_RATE);
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
      changeOiBaseline: oiRead?.baseline ?? null,
      ivPressurePct: pressurePct != null ? Math.round(pressurePct * 100) / 100 : null,
      changePercent: legChangePercent,
      iv: greeks.iv,
      delta: greeks.delta,
      gamma: greeks.gamma,
      theta: greeks.theta,
      vega: greeks.vega,
      // Buying vs writing is read from IV pressure, not the raw premium
      // change. Near expiry every premium falls on time decay alone, so "OI
      // up + premium down" labelled almost every leg WRITING regardless of
      // who traded; and a premium that rose only because the underlying did
      // read as BUYING. What's left after repricing for the underlying's
      // move and decay is whether the option was bid up or pressed down.
      oiInterpretation: classifyOptionOI({ priceChange: pressurePct ?? 0, oiChange: changeOi }, optionType, IV_PRESSURE_MIN_PCT),
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

  // Expiry session: yesterday's IV can't price the last hours — implied vol
  // per unit of remaining time rises into the close, and the smile steepens
  // — so legs sit above their "fair" repricing and calls and puts ALL read
  // as bought (17 Sep: SENSEX 19 call-buying and 22 put-buying legs at once).
  // Take out that shift before repricing each leg: the median change in IV
  // points across the legs (both sides) at the EXPIRY_SHIFT_NEIGHBOURS
  // strikes nearest that leg's own strike. A single chain-wide median fixed
  // the near-ATM legs but left the wings, where the smile moved further,
  // leaning "bought" on both sides (SENSEX calls 17 up / 6 down, puts
  // 16 / 2). A local median follows the smile, and one strike's own flow
  // still stands out against its ~13 neighbours. Measured in vol points and
  // repriced per strike, so it carries across moneyness. Other days keep the
  // absolute read: a chain-wide IV drop there is real premium selling.
  if (dte === 0 && tteAtQuote > 0) {
    const legsWithInputs = (s: OptionChainStrike) =>
      [
        [s.call, 'CE'],
        [s.put, 'PE'],
      ] as const;
    const shiftByStrike = new Map<number, number[]>();
    for (const st of strikes) {
      const values = legsWithInputs(st)
        .map(([leg]) => {
          const inputs = leg ? pressureInputs.get(leg.token) : undefined;
          return leg && inputs && leg.iv > 0 ? leg.iv / 100 - inputs.prevIv : null;
        })
        .filter((v): v is number => v != null);
      shiftByStrike.set(st.strike, values);
    }
    const median = (values: number[]) => {
      const sorted = values.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    for (const st of strikes) {
      const neighbourShifts = strikes
        .slice()
        .sort((a, b) => Math.abs(a.strike - st.strike) - Math.abs(b.strike - st.strike))
        .slice(0, EXPIRY_SHIFT_NEIGHBOURS)
        .flatMap((n) => shiftByStrike.get(n.strike) ?? []);
      if (neighbourShifts.length < 4) continue;
      const localShift = median(neighbourShifts);
      {
        for (const [leg, optionType] of legsWithInputs(st)) {
          const inputs = leg ? pressureInputs.get(leg.token) : undefined;
          if (!leg || !inputs) continue;
          const iv = inputs.prevIv + localShift;
          if (!(iv > 0)) continue;
          const fair = blackScholesPrice({ spotPrice: pricingSpotNow, strikePrice: st.strike, timeToExpiry: tteAtQuote, riskFreeRate: RISK_FREE_RATE, iv, optionType });
          if (!(fair > 0)) continue;
          const adjusted = ((inputs.ltp - fair) / inputs.prevPremium) * 100;
          leg.ivPressurePct = Math.round(adjusted * 100) / 100;
          leg.oiInterpretation = classifyOptionOI({ priceChange: adjusted, oiChange: leg.changeOi }, optionType, IV_PRESSURE_MIN_PCT);
        }
      }
    }
  }

  const pcrDetail = calculatePCR(strikes, spotPrice);
  const maxPainDetail = calculateMaxPain(strikes, spotPrice, underlying, expiry);

  const atmEntry = strikes.find((s) => s.strike === atmStrike) ?? strikes[Math.floor(strikes.length / 2)];
  const atmIvSamples = [atmEntry?.call?.iv, atmEntry?.put?.iv].filter((v): v is number => !!v && v > 0);
  const atmIv = atmIvSamples.length > 0 ? atmIvSamples.reduce((a, b) => a + b, 0) / atmIvSamples.length / 100 : 0.15;

  // Fractional days of option life left, not the whole-day DTE: on expiry
  // day DTE is 0 but the session still has hours to run.
  const expectedMoveDetail = calculateExpectedMove(spotPrice, atmIv, tteAtQuote * 365, underlying);

  const positionMomentum = analyzePositionMomentum(strikes);
  const oiTrap = analyzeOiTrap(strikes, spotPrice);
  const decay = analyzeTimeDecay(strikes, atmStrike, dte);
  const gammaExposure = calculateGammaExposure(strikes, spotPrice);

  return {
    symbol: underlying,
    underlying,
    exchange,
    spotPrice,
    underlyingChange,
    underlyingChangePercent,
    expiry,
    availableExpiries,
    dte,
    strikeInterval,
    atmStrike,
    // All strikes/expiries of the same underlying share one contract lot
    // size in Indian F&O — any option instrument's own value is correct.
    lotSize: optionInstruments[0]?.lotSize ?? 1,
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

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365.25 * DAY_MS; // yearsToExpiry's own year length
// Pressure inside this band (% of previous close premium) is noise — model
// error and bid-ask bounce — and reads as NEUTRAL rather than a side.
const IV_PRESSURE_MIN_PCT = 2;
// Below this previous-close premium the IV solve and the % are dominated by
// tick size.
const MIN_MODELLABLE_PREMIUM = 0.5;
// Strikes nearest ATM used to read the implied forward — the median absorbs
// one stale or off-market last trade.
const PARITY_STRIKES = 5;
// Strikes (both legs each) whose IV change sets an expiry-day leg's local
// baseline — wide enough that one strike's own flow is outvoted, narrow
// enough to follow the smile.
const EXPIRY_SHIFT_NEIGHBOURS = 7;

/**
 * The forward the options are priced off, from put-call parity
 * (C − P = e^(−rT)·(F − K), so F = K + (C − P)·e^(rT)), median across the
 * given strikes. Null when fewer than 3 strikes have both legs priced.
 */
function impliedForward(pairs: Array<{ strike: number; call?: number; put?: number }>, tte: number): number | null {
  const growth = Math.exp(RISK_FREE_RATE * Math.max(0, tte));
  const forwards = pairs
    .filter((p) => (p.call ?? 0) > 0 && (p.put ?? 0) > 0)
    .map((p) => p.strike + (p.call! - p.put!) * growth)
    .sort((a, b) => a - b);
  if (forwards.length < 3) return null;
  const mid = Math.floor(forwards.length / 2);
  return forwards.length % 2 === 1 ? forwards[mid] : (forwards[mid - 1] + forwards[mid]) / 2;
}

/**
 * How far the option's price sits from what the underlying's move and time
 * decay alone would have made it, as % of the previous close premium.
 * Solves the IV the option closed at yesterday, reprices it at today's
 * underlying (the parity-implied forward, passed in spot terms) and
 * remaining time with that SAME IV, and compares to the live premium:
 * the residual is the IV change — buyers bidding options up, or writers
 * pressing them down. Null when it can't be modelled (no/illiquid quote,
 * premium at intrinsic, IV unresolvable).
 */
function ivPressure(
  prevPremium: number,
  ltp: number,
  spotPrev: number,
  spotNow: number,
  strike: number,
  optionType: OptionType,
  tteAtPrevClose: number,
  tteNow: number
): { pct: number; prevIv: number } | null {
  if (!(prevPremium >= MIN_MODELLABLE_PREMIUM) || !(ltp > 0) || !(spotPrev > 0) || !(tteNow > 0)) return null;
  const prevIv = calculateIV(prevPremium, spotPrev, strike, tteAtPrevClose, RISK_FREE_RATE, optionType);
  if (!(prevIv > 0)) return null;
  const fairNow = blackScholesPrice({ spotPrice: spotNow, strikePrice: strike, timeToExpiry: tteNow, riskFreeRate: RISK_FREE_RATE, iv: prevIv, optionType });
  if (!(fairNow > 0)) return null;
  return { pct: ((ltp - fairNow) / prevPremium) * 100, prevIv };
}

function sliceStrikesAroundAtm(strikes: OptionChainStrike[], atmStrike: number, range: number): OptionChainStrike[] {
  if (strikes.length === 0) return strikes;
  const atmIndex = strikes.reduce(
    (closest, s, idx) => (Math.abs(s.strike - atmStrike) < Math.abs(strikes[closest].strike - atmStrike) ? idx : closest),
    0
  );
  return strikes.slice(Math.max(0, atmIndex - range), atmIndex + range + 1);
}

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
        // FUTIDX/FUTSTK too: market-bias borrows an index future's volume
        // (NSE/BSE index candles carry none). MCX lists only FUTCOM, so its
        // callers are unaffected.
        (i.instrumentType === 'FUTCOM' || i.instrumentType === 'FUTIDX' || i.instrumentType === 'FUTSTK') &&
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
