// ============================================================
// MARKET SCANNER
// ============================================================
// Automates the manual top-down workflow: read NIFTY/BANKNIFTY/VIX/
// breadth for overall market trend -> shortlist the top liquid movers
// across the WHOLE F&O universe (any sector, not restricted to one) ->
// run the full per-symbol signal engine on each -> score every
// candidate 0-100 across 8 categories (Market Trend, Sector Strength,
// Price Action, EMA Trend, Volume, Option Chain, OI Buildup, SMC
// Structure) -> surface only the ones scoring >= 60.
//
// Originally restricted candidates to only the single strongest/
// weakest sector's top 5 members — dropped after a real miss: a stock
// (PNBHOUSING) rallied hard but was never even considered because it
// wasn't sector-tagged and its "Other" bucket wasn't that cycle's
// extreme sector. Sector strength is still computed and still feeds
// each candidate's own Sector Strength score (via whichever sector
// that specific stock actually belongs to), and the single strongest/
// weakest sector is still surfaced as market context — it just no
// longer gates which stocks get a chance to be scored at all.
//
// A related gap: `candidates` is always aligned to the single overall
// market direction (CE-only on a bullish day, PE-only on a bearish one),
// so a stock defying the broader tape on its own strength (real example:
// LODHA rallying hard on a bearish-market day) could never appear there no
// matter how strong its own setup was. `stockSpecificMovers` is a second,
// independent pass that scores strong own-direction standouts (picked by
// relative-strength magnitude vs NIFTY, not a coarse confidence heuristic —
// see shortlistStockSpecificMovers for why) regardless of the market's
// call — it's the only non-empty output on a SIDEWAYS day, and on a
// trending day it surfaces genuine counter-trend strength that
// `candidates` structurally can't.
//
// Deliberately reuses the existing per-symbol engine (buildMarketBias)
// rather than re-deriving RSI/VWAP/Supertrend/OI/SMC signals a second
// time — it already computes everything this scoring model needs, and
// is only called for the shortlisted finalists per cycle (not the
// whole ~180-stock universe, which stays on fno-scanner.ts's lighter
// quote-only path for the initial ranking) — the shortlist is wider
// than before (SHORTLIST_SIZE) precisely so a real mover anywhere in
// the universe has a chance to surface, not just within one sector.
// ============================================================

import { getOIDescription } from '@fno/analytics';
import type {
  Exchange,
  FnoScannerRow,
  MarketBias,
  MarketScanResult,
  MarketTrend,
  MarketTrendRead,
  OptionType,
  ScannedCandidate,
  ScanPortfolioRisk,
  ScannerScoreBreakdown,
  ScannerSetupTier,
  SectorRank,
} from '@fno/shared';
import { DEFAULT_RISK_CONFIG, LIQUID_SPREAD_MAX_PCT, isMarketOpen } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { buildMarketBias } from './market-bias.js';
import { scanFnoUniverse } from './fno-scanner.js';
import { getLiveIndexQuotes } from './indices.js';
import { computeMarketBreadth } from './market-breadth.js';
import { neutralSectorRank, rankSectors, sectorForSymbol } from './sector-strength.js';
import { cached } from '../lib/cache.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

// Wider than the old single-sector top-5 — this is now drawn from the
// ENTIRE F&O universe, so a real mover in an untagged or otherwise-quiet
// sector still gets a shot at being scored. Was briefly 15: each shortlisted
// symbol runs the FULL multi-call signal engine (buildMarketBias: quote +
// historical candles + option chain + Greeks + futures), and 15 main + up
// to 10 stock-specific movers per 5-minute cycle (~25 symbols, ~125+ calls
// in a burst) pushed Angel One's real rate limit hard enough to trip a
// live, sustained 403 storm across the WHOLE app (confirmed via Railway
// logs) — not just the scanner. Pulled back to keep this feature's own
// background load in a safe range; the hysteresis carryover (see
// shortlistStocks) means a genuine standout that's outside this smaller
// top-N still doesn't just vanish once it's already surfaced.
const SHORTLIST_SIZE = 8;
const MIN_STOCK_VOLUME = 50_000; // floor beneath which a "liquid" spread reading isn't trustworthy either
const SCORE_SURFACE_FLOOR = 60; // spec's own "Weak setup, generally avoid" cutoff — nothing below this is shown at all

// The 8 scoring categories sum to 100 (see ScannerScoreBreakdown).
const MAX_SCORE = 100;
const MARKET_TREND_MAX = 15;
// Stock-specific movers always score 0 on the 15-point Market Trend
// category by construction (see scoreCandidate) — the market's own read
// disagrees with them, that's the whole point of the category. Their real
// achievable max is 85, not 100, so applying the same flat 60 here would
// demand ~70% of what's actually possible instead of 60% — a stricter bar
// than intended, and the reason this section stayed empty even on days
// with several genuine, sizeable counter-trend movers live. Both the floor
// and the tier bands are scaled to this ceiling instead.
const STOCK_SPECIFIC_MAX_SCORE = MAX_SCORE - MARKET_TREND_MAX;
const STOCK_SPECIFIC_SCORE_FLOOR = Math.round(SCORE_SURFACE_FLOOR * (STOCK_SPECIFIC_MAX_SCORE / MAX_SCORE));
const NIFTY_TREND_MIN_CONFIDENCE = 55;

const SCAN_CACHE_KEY = 'market_scan:latest';
const SCAN_CACHE_TTL_SECONDS = 360; // a little over the 5-minute background interval, so the API never serves a fully-expired read

// Tiers are judged against what the candidate could ACTUALLY have scored,
// not a flat 100. A stock-specific mover forfeits the whole 15-point Market
// Trend category by construction (the broader market disagrees with it —
// that's what makes it stock-specific), so its ceiling is 85 and a flat
// >=80 bar for HIGH_CONVICTION was very nearly unreachable: those setups
// were labelled "Weak" almost regardless of how strong they actually were.
// A null atmSpreadPct means neither ATM leg quoted a genuine two-sided
// market this tick — that's evidence of ILLIQUIDITY, but the gate used to
// read `atmSpreadPct == null || atmSpreadPct <= MAX` and let it through,
// admitting exactly the names it was meant to keep out. Only a real,
// measured, tight spread passes now.
function isTradeablySpread(row: FnoScannerRow): boolean {
  return row.atmSpreadPct != null && row.atmSpreadPct <= LIQUID_SPREAD_MAX_PCT;
}

function tierFor(score: number, maxPossible: number): ScannerSetupTier {
  const pct = maxPossible > 0 ? (score / maxPossible) * 100 : 0;
  return pct >= 80 ? 'HIGH_CONVICTION' : pct >= 70 ? 'WATCHLIST' : 'WEAK';
}

// --- Step 1: overall market trend ---

async function assessMarketTrend(provider: MarketDataProvider, fnoRows: FnoScannerRow[]): Promise<MarketTrendRead> {
  const [{ bias: niftyBias }, { bias: bankNiftyBias }, { bias: finniftyBias }, vixQuotes] = await Promise.all([
    buildMarketBias(provider, 'NIFTY', 'NSE'),
    buildMarketBias(provider, 'BANKNIFTY', 'NSE'),
    buildMarketBias(provider, 'FINNIFTY', 'NSE'),
    getLiveIndexQuotes(provider, [{ symbol: 'INDIAVIX', exchange: 'NSE' }]).catch(() => []),
  ]);
  const vix = vixQuotes[0]?.ltp ?? null;
  const breadth = computeMarketBreadth(fnoRows);

  // Three-index confirmation: NIFTY, BANKNIFTY, and FINNIFTY must ALL
  // independently clear the confidence bar in the same direction — a
  // single index's own bias engine can be noisy, and BANKNIFTY/FINNIFTY
  // previously weren't actually part of the gate at all (fetched but only
  // shown for context), which meant the "market trend" verdict was really
  // just "NIFTY + breadth." Stricter by design: this reads SIDEWAYS more
  // often than before whenever the three disagree, which is the point —
  // a real market-wide trend should show up across more than one index.
  const isBullish = (b: typeof niftyBias) => b.direction === 'BULLISH' && b.confidence >= NIFTY_TREND_MIN_CONFIDENCE;
  const isBearish = (b: typeof niftyBias) => b.direction === 'BEARISH' && b.confidence >= NIFTY_TREND_MIN_CONFIDENCE;
  const allBullish = isBullish(niftyBias) && isBullish(bankNiftyBias) && isBullish(finniftyBias);
  const allBearish = isBearish(niftyBias) && isBearish(bankNiftyBias) && isBearish(finniftyBias);

  // breadth.isBullishBias is null when the F&O universe scan came back
  // empty that tick (no data, not a real reading) — in that case it must
  // never veto an otherwise-unanimous three-index call, so only an
  // EXPLICIT contradicting breadth reading (=== false for a bullish call,
  // === true for a bearish one) blocks the trend here.
  let trend: MarketTrend;
  const reasoning: string[] = [];
  if (allBullish && breadth.isBullishBias !== false) {
    trend = 'BULLISH';
    reasoning.push(
      `NIFTY (${niftyBias.confidence}%), BANK NIFTY (${bankNiftyBias.confidence}%) and FIN NIFTY (${finniftyBias.confidence}%) all bullish` +
        (breadth.isBullishBias == null
          ? ', breadth unavailable this tick'
          : `, breadth favors advances (${breadth.advances} vs ${breadth.declines})`)
    );
  } else if (allBearish && breadth.isBullishBias !== true) {
    trend = 'BEARISH';
    reasoning.push(
      `NIFTY (${niftyBias.confidence}%), BANK NIFTY (${bankNiftyBias.confidence}%) and FIN NIFTY (${finniftyBias.confidence}%) all bearish` +
        (breadth.isBullishBias == null
          ? ', breadth unavailable this tick'
          : `, breadth favors declines (${breadth.declines} vs ${breadth.advances})`)
    );
  } else {
    trend = 'SIDEWAYS';
    reasoning.push(
      `NIFTY ${niftyBias.direction} ${niftyBias.confidence}%, BANK NIFTY ${bankNiftyBias.direction} ${bankNiftyBias.confidence}%, FIN NIFTY ${finniftyBias.direction} ${finniftyBias.confidence}% — not all three agree (or breadth disagrees), so no clean market-wide trend`
    );
  }

  // Same VIX-score formula institutional-flow.ts already uses, for
  // consistency across the app: low VIX (calm) scores high, elevated VIX
  // (fear/uncertainty) scores low, clamped 0-100.
  const vixScore = vix != null ? Math.max(0, Math.min(100, 100 - (vix - 10) * 4)) : 50;
  const avgConfidence =
    trend !== 'SIDEWAYS' ? (niftyBias.confidence + bankNiftyBias.confidence + finniftyBias.confidence) / 3 : niftyBias.confidence;
  const confidenceComponent = Math.round((avgConfidence / 100) * 10);
  // Explicit === checks, not truthiness — with breadth.isBullishBias
  // possibly null (no data this tick), `!null` is true and would wrongly
  // award this bonus for a BEARISH trend whose breadth is actually unknown.
  const breadthComponent = (trend === 'BULLISH' && breadth.isBullishBias === true) || (trend === 'BEARISH' && breadth.isBullishBias === false) ? 3 : 0;
  const vixComponent = Math.round((vixScore / 100) * 2);
  const score = trend === 'SIDEWAYS' ? Math.round(confidenceComponent * 0.5) : Math.min(15, confidenceComponent + breadthComponent + vixComponent);

  if (vix != null) reasoning.push(`India VIX at ${vix.toFixed(2)}`);

  return { trend, score, niftyBias, bankNiftyBias, finniftyBias, vix, breadth, reasoning };
}

// --- Hysteresis: a candidate shouldn't vanish the instant it dips just
// under the entry bar. Persists which symbols were showing last cycle so a
// small, temporary score dip (a momentary volume/OI/IV tick, not a real
// reversal) doesn't flicker it out of the list every 5 minutes — it takes
// a real drop below the lower EXIT floor to actually remove it. TTL is a
// few scan cycles, not a full day: if scanning stops (market closes) the
// carried-over state quietly expires instead of surviving into tomorrow.
const HYSTERESIS_MARGIN = 10; // points below the entry floor a previously-shown candidate may still drift
const SHOWN_STATE_TTL_SECONDS = 20 * 60;
const SHOWN_CANDIDATES_KEY = 'market_scan:shown:candidates';
const SHOWN_STOCK_SPECIFIC_KEY = 'market_scan:shown:stock_specific';

async function readShownSymbols(key: string): Promise<Set<string>> {
  try {
    const raw = await redis.get(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

async function writeShownSymbols(key: string, symbols: Set<string>): Promise<void> {
  await redis.set(key, JSON.stringify([...symbols]), 'EX', SHOWN_STATE_TTL_SECONDS);
}

// --- Step 2: whole-universe stock shortlist ---
// No longer restricted to one "picked" sector's members — ranks every
// liquid F&O stock by relative strength (in the market's preferred
// direction) and takes the top N, regardless of which sector it's in.
// Sector strength still feeds each candidate's own score (see
// scoreCandidate), it just no longer gates who's even considered. Also
// carries over any symbol still showing from last cycle (hysteresis) even
// if it's since slipped out of the top-N rank cut, so scoreShortlist below
// gets a chance to re-evaluate it against the lower exit floor rather than
// dropping it purely because something else briefly outranked it.

function shortlistStocks(fnoRows: FnoScannerRow[], trend: MarketTrend, previouslyShown: Set<string>): FnoScannerRow[] {
  const liquid = fnoRows.filter(
    (r) => r.volume >= MIN_STOCK_VOLUME && isTradeablySpread(r)
  );
  liquid.sort((a, b) => (trend === 'BULLISH' ? b.relativeStrength - a.relativeStrength : a.relativeStrength - b.relativeStrength));
  const topN = liquid.slice(0, SHORTLIST_SIZE);
  const topNSymbols = new Set(topN.map((r) => r.symbol));
  const carryover = liquid.filter((r) => previouslyShown.has(r.symbol) && !topNSymbols.has(r.symbol));
  return [...topN, ...carryover];
}

// --- Step 2b: stock-specific movers (independent of / against the market's own trend) ---
// The main shortlist above only ever looks one direction (whichever side the
// overall market favors), sorted so the strongest names in that direction
// win. That structurally excludes a stock like LODHA rallying hard on its
// own strength while the broader tape reads bearish — it would sort to the
// wrong end of that same list. This is a separate, independent pass: pick
// the strongest own-direction outperformers in EITHER direction, run the
// same signal engine on them, and surface them as their own category so a
// standout never goes unseen just because it defies the day's market call.
//
// Originally gated on fno-scanner.ts's lightweight per-row `confidence` —
// a coarse 3-vote (price/OI/PCR) heuristic that can only ever read 33%,
// 67%, or 100%. Requiring >=65% demanded 2 of those 3 signals agree, but
// OI/PCR positioning routinely lags or sits neutral during a genuine price
// rally, so a real move on price alone often scored only 33% and got
// filtered out before it was ever scored by the real engine — the exact
// bug that hid decent bull rallies on bearish-market days. Filters on
// relative-strength magnitude instead (a direct, continuous measure of
// "how much is this stock actually outperforming/underperforming today"),
// cross-checked against the stock's own raw price change so relative
// "strength" from merely falling less than the index doesn't count.
const STOCK_SPECIFIC_MIN_RELATIVE_STRENGTH = 1.5; // real move vs NIFTY, not everyday dispersion noise
// Was 5 (10 total): combined with SHORTLIST_SIZE above, this was the other
// half of the load that tripped a live rate-limit storm — see that
// comment. 3 per direction (6 total) still gives real counter-trend
// coverage at a fraction of the API cost.
const STOCK_SPECIFIC_PER_DIRECTION = 3;

function shortlistStockSpecificMovers(fnoRows: FnoScannerRow[], excludeSymbols: Set<string>, previouslyShown: Set<string>): FnoScannerRow[] {
  const eligible = fnoRows.filter(
    (r) =>
      !excludeSymbols.has(r.symbol) &&
      r.volume >= MIN_STOCK_VOLUME &&
      isTradeablySpread(r)
  );
  const bullish = eligible
    .filter((r) => r.changePercent > 0 && r.relativeStrength >= STOCK_SPECIFIC_MIN_RELATIVE_STRENGTH)
    .sort((a, b) => b.relativeStrength - a.relativeStrength)
    .slice(0, STOCK_SPECIFIC_PER_DIRECTION);
  const bearish = eligible
    .filter((r) => r.changePercent < 0 && r.relativeStrength <= -STOCK_SPECIFIC_MIN_RELATIVE_STRENGTH)
    .sort((a, b) => a.relativeStrength - b.relativeStrength)
    .slice(0, STOCK_SPECIFIC_PER_DIRECTION);
  // Hysteresis carryover: a previously-shown symbol still moving the same
  // raw direction (changePercent sign unchanged) gets re-evaluated even if
  // its relative-strength has since dipped below the entry threshold. A
  // symbol that's fully reversed direction is a real invalidation, not
  // noise, so it's deliberately NOT carried over.
  const selected = new Set([...bullish, ...bearish].map((r) => r.symbol));
  const carryover = eligible.filter((r) => previouslyShown.has(r.symbol) && !selected.has(r.symbol) && r.changePercent !== 0);
  return [...bullish, ...bearish, ...carryover];
}

// --- Step 3: per-candidate scoring ---

interface BiasInputsSubset {
  spotPrice: number;
  vwap: number;
  ema20: number | null;
  ema50: number | null;
  emaAligned: 'BULLISH' | 'BEARISH' | null;
  volumeRatio: number;
  /** False when the feed carries no volume for this symbol — volumeRatio is then a 1.0 stand-in, not a measurement. */
  volumeDataAvailable: boolean;
  dte: number | null;
  optionOiFlow: string | null;
  optionOiFlowNetSkew: number;
  futuresOi: string;
  chartStructureShort: { direction: 'BULLISH' | 'BEARISH'; confidence: number } | null;
  chartStructureLong: { direction: 'BULLISH' | 'BEARISH'; confidence: number } | null;
  lastStructureEvent: { type: 'BOS' | 'CHOCH'; direction: 'BULLISH' | 'BEARISH' } | null;
  liquiditySweep: { type: 'BUY_SIDE' | 'SELL_SIDE' } | null;
  activeFvg: { type: 'BULLISH' | 'BEARISH' } | null;
  activeOrderBlock: { type: 'BULLISH' | 'BEARISH' } | null;
}

function scoreCandidate(
  marketTrend: MarketTrendRead,
  sector: SectorRank,
  stockBias: MarketBias,
  side: OptionType,
  candidateIvRank: number | null
): { breakdown: ScannerScoreBreakdown; reasoning: string[] } {
  const wantsBullish = side === 'CE';
  const inputs = stockBias.inputs as unknown as BiasInputsSubset;
  const reasoning: string[] = [];

  // Market Trend: the shared step-1 score, but zeroed unless BOTH (a) this
  // stock's own read confirms `side`, AND (b) `side` itself is the market's
  // own preferred direction this cycle — the spec's "market + sector +
  // stock alignment" requirement, not just "NIFTY is bullish somewhere out
  // there." Condition (b) matters for stock-specific movers scored against
  // their OWN direction even when it defies the broader market (e.g. a
  // bullish stock on a bearish-market day) — those should never collect
  // market-trend credit they haven't earned.
  const stockAgrees = (wantsBullish && stockBias.direction === 'BULLISH') || (!wantsBullish && stockBias.direction === 'BEARISH');
  const marketSide: OptionType | null = marketTrend.trend === 'BULLISH' ? 'CE' : marketTrend.trend === 'BEARISH' ? 'PE' : null;
  const alignedWithMarket = marketSide === side;
  const marketTrendScore = stockAgrees && alignedWithMarket ? marketTrend.score : 0;
  if (!stockAgrees) {
    reasoning.push(`Stock's own bias (${stockBias.direction}) doesn't confirm ${side} — Market Trend score zeroed`);
  } else if (!alignedWithMarket) {
    reasoning.push(`Independent of today's ${marketTrend.trend} market read — standalone stock-specific setup, Market Trend score zeroed`);
  }

  // Sector Strength: this candidate's OWN sector (looked up per-stock, not
  // one shared "picked" sector for the whole batch), scored in the DIRECTION
  // of the trade — a CE wants its sector outperforming, a PE wants it
  // underperforming.
  //
  // Was `5 + Math.abs(avgRelativeStrength) * 2`, which had two bugs: the
  // absolute value meant a CE candidate sitting in the day's WEAKEST sector
  // scored a full 10/10 for "sector strength", and the +5 floor handed every
  // candidate half the category for free — including ones whose sector is
  // entirely unknown (neutralSectorRank, memberCount 0), which is missing
  // data, not neutral-but-measured evidence.
  const signedSectorStrength = wantsBullish ? sector.avgRelativeStrength : -sector.avgRelativeStrength;
  const SECTOR_FULL_MARKS_PCT = 2.5; // outperformance vs NIFTY that earns the full 10
  const sectorStrengthScore =
    sector.memberCount === 0
      ? 0
      : Math.max(0, Math.min(10, Math.round((signedSectorStrength / SECTOR_FULL_MARKS_PCT) * 10)));
  if (sector.memberCount === 0) {
    reasoning.push(`No sector data for this symbol — Sector Strength scored 0 rather than assumed neutral`);
  } else {
    reasoning.push(
      `${sector.sector} sector relative strength ${sector.avgRelativeStrength > 0 ? '+' : ''}${sector.avgRelativeStrength}% vs NIFTY` +
        (signedSectorStrength <= 0 ? ` — moving against this ${side}, so no credit` : '')
    );
  }

  // Price Action / Setup: BREAKOUT/BREAKDOWN regime agreeing with side is
  // the strongest single read here (a leading, volume-confirmed signal);
  // chart-structure pattern agreement, VWAP position, and a BOS/CHoCH
  // structure event each add a slice on top. VWAP lives here (rather than
  // as its own category) because the spec treats it as an intraday price-
  // action confirmation, not an independent signal — "price sustains above
  // breakout, VWAP supports the move" in the spec's own entry-trigger flow.
  let priceActionScore = 0;
  if ((wantsBullish && stockBias.regime === 'BREAKOUT') || (!wantsBullish && stockBias.regime === 'BREAKDOWN')) {
    priceActionScore += 8;
    reasoning.push(`Volume-confirmed ${stockBias.regime.toLowerCase()} regime agrees with ${side}`);
  }
  const patternDir = inputs.chartStructureLong?.direction ?? inputs.chartStructureShort?.direction ?? null;
  const patternConfidence = inputs.chartStructureLong?.confidence ?? inputs.chartStructureShort?.confidence ?? 0;
  if (patternDir === (wantsBullish ? 'BULLISH' : 'BEARISH')) {
    priceActionScore += Math.round((patternConfidence / 100) * 5);
    reasoning.push(`Chart structure pattern agrees with ${side} (${patternConfidence}% confidence)`);
  }
  const vwapAgrees = wantsBullish ? inputs.spotPrice > inputs.vwap : inputs.spotPrice < inputs.vwap;
  if (vwapAgrees) {
    priceActionScore += 4;
    reasoning.push(`Price ${wantsBullish ? 'above' : 'below'} VWAP, confirming ${side}`);
  }
  if (inputs.lastStructureEvent && inputs.lastStructureEvent.direction === (wantsBullish ? 'BULLISH' : 'BEARISH')) {
    priceActionScore += inputs.lastStructureEvent.type === 'CHOCH' ? 3 : 2;
    reasoning.push(`${inputs.lastStructureEvent.type === 'CHOCH' ? 'Change of Character' : 'Break of Structure'} agrees with ${side}`);
  }
  priceActionScore = Math.min(20, priceActionScore);

  // EMA Trend: bias.inputs.emaAligned already folds in the slope check —
  // only counts if EMA20/EMA50 are genuinely stacked AND sloping this way,
  // not merely "price happens to be above them right now."
  const emaTrendScore = inputs.emaAligned === (wantsBullish ? 'BULLISH' : 'BEARISH') ? 10 : 0;
  if (emaTrendScore > 0) reasoning.push(`Price > EMA20 > EMA50 stacked and sloping ${side === 'CE' ? 'bullish' : 'bearish'}`);

  // Volume (/5): last COMPLETE bar vs its 20-bar average, from
  // market-bias.ts. Scores 0 when the feed carries no volume at all rather
  // than reading the 1.0 "no information" fallback as "exactly average".
  const volumeScore = inputs.volumeDataAvailable
    ? Math.max(0, Math.min(5, Math.round((inputs.volumeRatio - 1) * 5)))
    : 0;
  if (volumeScore > 0) reasoning.push(`Volume ${inputs.volumeRatio.toFixed(2)}x its 20-bar average`);
  else if (!inputs.volumeDataAvailable) reasoning.push(`No volume data on this feed — Volume scored 0 rather than assumed average`);

  // IV Environment (/10): this app only ever proposes BUYING a naked option,
  // so the volatility you pay on entry is a first-order term, not a detail —
  // yet the model had no IV or DTE component at all. Buying at a high IV
  // rank means paying up for a move that's already priced in and taking the
  // crush risk; near-zero DTE means theta and gamma dominate whatever
  // directional read got the candidate here.
  let ivEnvironmentScore = 0;
  if (candidateIvRank == null) {
    // Unknown IV rank (needs several days of history) — award the neutral
    // middle rather than 0 or full marks, and say so.
    ivEnvironmentScore = 3;
    reasoning.push(`IV rank unavailable (needs more daily history) — IV Environment scored as unknown, not favourable`);
  } else {
    // Low IV rank is what an option BUYER wants: 6 points at rank 0 sliding
    // to 0 by rank 60, nothing above that.
    const ivRankPoints = Math.max(0, Math.min(6, Math.round(((60 - candidateIvRank) / 60) * 6)));
    ivEnvironmentScore += ivRankPoints;
    reasoning.push(
      candidateIvRank >= 60
        ? `IV rank ${candidateIvRank} — expensive to buy, no IV credit`
        : `IV rank ${candidateIvRank} — reasonable premium to be buying`
    );
  }
  // DTE: 0-1 DTE is the worst case for a long option (theta/gamma dominate),
  // a comfortable 5+ days is the best.
  const dte = inputs.dte;
  if (dte == null) {
    ivEnvironmentScore += 2;
  } else if (dte <= 1) {
    reasoning.push(`${dte} DTE — expiry-day theta/gamma work directly against a long option, no DTE credit`);
  } else if (dte <= 3) {
    ivEnvironmentScore += 2;
  } else {
    ivEnvironmentScore += 4;
  }
  ivEnvironmentScore = Math.min(10, ivEnvironmentScore);

  // Option Chain: the real buying/writing/covering/unwinding flow read
  // (this session's addition to market-bias.ts), scaled by how skewed it
  // is — a 90/10 dominant read counts more than a bare 51/49 majority.
  const oiFlowImplication = inputs.optionOiFlow ? getOIDescription(inputs.optionOiFlow as any).implication : 'NEUTRAL';
  const oiFlowAgrees = (wantsBullish && oiFlowImplication === 'BULLISH') || (!wantsBullish && oiFlowImplication === 'BEARISH');
  const optionChainScore = oiFlowAgrees ? Math.min(15, Math.round(Math.abs(inputs.optionOiFlowNetSkew) * 15)) : 0;
  if (oiFlowAgrees) reasoning.push(`${inputs.optionOiFlow} option OI flow agrees with ${side}`);

  // OI Build-up: futures OI interpretation (LONG_BUILDUP/SHORT_COVERING
  // bullish, SHORT_BUILDUP/LONG_UNWINDING bearish per classifyFuturesOI).
  const futuresImplication = getOIDescription(inputs.futuresOi as any).implication;
  const oiBuildupScore = (wantsBullish && futuresImplication === 'BULLISH') || (!wantsBullish && futuresImplication === 'BEARISH') ? 10 : 0;
  if (oiBuildupScore > 0) reasoning.push(`Futures OI (${inputs.futuresOi}) agrees with ${side}`);

  // SMC Structure (/5): liquidity sweep, FVG, order block — each worth a
  // slice, only when its direction agrees with this side.
  //
  // lastStructureEvent (BOS/CHoCH) is deliberately NOT scored here any more:
  // it already earns 2-3 points in Price Action above, and counting the same
  // single event in two categories presented as independent was inflating
  // one signal to as much as 6 points. It's also the same swing-structure
  // model the sweep/FVG/order-block reads come from, so this whole category
  // is one interpretation viewed four ways — which is why it's now worth 5
  // rather than 10.
  let smcStructureScore = 0;
  if (inputs.liquiditySweep && (wantsBullish ? inputs.liquiditySweep.type === 'SELL_SIDE' : inputs.liquiditySweep.type === 'BUY_SIDE')) {
    smcStructureScore += 3;
    reasoning.push(`${inputs.liquiditySweep.type === 'SELL_SIDE' ? 'Sell-side' : 'Buy-side'} liquidity sweep agrees with ${side}`);
  }
  if (inputs.activeFvg?.type === (wantsBullish ? 'BULLISH' : 'BEARISH')) smcStructureScore += 1;
  if (inputs.activeOrderBlock?.type === (wantsBullish ? 'BULLISH' : 'BEARISH')) smcStructureScore += 1;
  smcStructureScore = Math.min(5, smcStructureScore);

  return {
    breakdown: {
      marketTrend: marketTrendScore,
      sectorStrength: sectorStrengthScore,
      priceAction: priceActionScore,
      ivEnvironment: ivEnvironmentScore,
      emaTrend: emaTrendScore,
      volume: volumeScore,
      optionChain: optionChainScore,
      oiBuildup: oiBuildupScore,
      smcStructure: smcStructureScore,
    },
    reasoning,
  };
}

function sumBreakdown(b: ScannerScoreBreakdown): number {
  return (
    b.marketTrend + b.sectorStrength + b.priceAction + b.ivEnvironment + b.emaTrend + b.volume + b.optionChain + b.oiBuildup + b.smcStructure
  );
}

// --- Pipeline entry point ---

async function scoreShortlist(
  provider: MarketDataProvider,
  exchange: Exchange,
  shortlist: FnoScannerRow[],
  marketTrend: MarketTrendRead,
  sectorRankByName: Map<string, SectorRank>,
  sideFor: (row: FnoScannerRow) => OptionType | null,
  scoreFloor: number,
  shownStateKey: string,
  maxPossibleScore: number
): Promise<ScannedCandidate[]> {
  const previouslyShown = await readShownSymbols(shownStateKey);
  const exitFloor = Math.max(0, scoreFloor - HYSTERESIS_MARGIN);

  const results: ScannedCandidate[] = [];
  let attempted = 0;
  let failed = 0;
  for (const row of shortlist) {
    try {
      const side = sideFor(row);
      if (!side) continue;

      attempted += 1;
      const { bias, tradeSetup } = await buildMarketBias(provider, row.symbol, exchange);
      if (!tradeSetup.available) continue;

      const ownSectorName = sectorForSymbol(row.symbol);
      const ownSector = sectorRankByName.get(ownSectorName) ?? neutralSectorRank(ownSectorName);

      const { breakdown, reasoning } = scoreCandidate(marketTrend, ownSector, bias, side, row.ivRank);
      const score = sumBreakdown(breakdown);
      // Hysteresis: a symbol already showing gets the lower exit floor, not
      // the entry floor — a small dip shouldn't flicker it out the moment
      // it crosses back under the entry bar.
      const effectiveFloor = previouslyShown.has(row.symbol) ? exitFloor : scoreFloor;
      if (score < effectiveFloor) continue;

      results.push({
        symbol: row.symbol,
        exchange,
        sector: ownSectorName,
        side,
        score,
        tier: tierFor(score, maxPossibleScore),
        scoreBreakdown: breakdown,
        tradeSetup,
        reasoning,
        atmIv: row.atmIv,
        ivRank: row.ivRank,
      });
    } catch (err: any) {
      failed += 1;
      logger.warn({ error: err.message, symbol: row.symbol }, 'Market scanner: one candidate failed, skipping');
    }
  }
  results.sort((a, b) => b.score - a.score);

  // Only rewrite the hysteresis memory when this cycle actually learned
  // something. An empty result set produced by a broker outage (every
  // buildMarketBias throwing — exactly what a rate-limit storm looks like)
  // used to overwrite the shown-set with {}, wiping the carryover state that
  // hysteresis exists to provide and making a transient failure permanently
  // reset the list it was meant to keep stable.
  const cycleUsable = attempted === 0 || failed < attempted;
  if (cycleUsable) {
    await writeShownSymbols(shownStateKey, new Set(results.map((r) => r.symbol)));
  } else {
    logger.warn({ attempted, failed, shownStateKey }, 'Market scanner: every candidate failed — keeping previous hysteresis state');
  }
  return results;
}

export async function runMarketScan(provider: MarketDataProvider, exchange: Exchange = 'NSE'): Promise<MarketScanResult> {
  const fnoRows = await scanFnoUniverse(provider, exchange);
  const marketTrend = await assessMarketTrend(provider, fnoRows);

  // Still computed for context (the top-level "today's strongest/weakest
  // sector" display) and as the source each candidate's OWN sector rank is
  // looked up from below — it just no longer restricts which stocks are
  // even considered (see shortlistStocks). Also needed on a SIDEWAYS day,
  // since stock-specific movers still run then.
  const sectorRanks = await rankSectors(provider, fnoRows);
  const sectorRankByName = new Map(sectorRanks.map((s) => [s.sector, s]));
  const contextSector =
    marketTrend.trend === 'BULLISH' ? sectorRanks[0] : marketTrend.trend === 'BEARISH' ? sectorRanks[sectorRanks.length - 1] : null;

  // Main, market-aligned candidates — only meaningful when the market has
  // an actual trend to align to. On a SIDEWAYS day there's no side to hunt.
  let candidates: ScannedCandidate[] = [];
  if (marketTrend.trend !== 'SIDEWAYS') {
    const previouslyShown = await readShownSymbols(SHOWN_CANDIDATES_KEY);
    const shortlist = shortlistStocks(fnoRows, marketTrend.trend, previouslyShown);
    const side: OptionType = marketTrend.trend === 'BULLISH' ? 'CE' : 'PE';
    candidates = await scoreShortlist(
      provider,
      exchange,
      shortlist,
      marketTrend,
      sectorRankByName,
      () => side,
      SCORE_SURFACE_FLOOR,
      SHOWN_CANDIDATES_KEY,
      MAX_SCORE
    );
  }

  // Stock-specific movers — strong own-direction standouts, scored
  // regardless of (and possibly against) the overall market read. Always
  // runs, including on SIDEWAYS days when it's the only useful output. Side
  // comes from the stock's own raw price change (matching how
  // shortlistStockSpecificMovers filtered it in), not the lightweight
  // vote-based `direction` field — that field can read NEUTRAL even while
  // changePercent is clearly one-sided, which would wrongly drop a real
  // mover here after it already earned its spot on relative strength.
  const excludeSymbols = new Set(candidates.map((c) => c.symbol));
  const previouslyShownStockSpecific = await readShownSymbols(SHOWN_STOCK_SPECIFIC_KEY);
  const stockSpecificShortlist = shortlistStockSpecificMovers(fnoRows, excludeSymbols, previouslyShownStockSpecific);
  const stockSpecificMovers = await scoreShortlist(
    provider,
    exchange,
    stockSpecificShortlist,
    marketTrend,
    sectorRankByName,
    (row) => (row.changePercent > 0 ? 'CE' : row.changePercent < 0 ? 'PE' : null),
    STOCK_SPECIFIC_SCORE_FLOOR,
    SHOWN_STOCK_SPECIFIC_KEY,
    STOCK_SPECIFIC_MAX_SCORE
  );

  return {
    marketTrend,
    sector: contextSector ?? null,
    candidates,
    portfolioRisk: computePortfolioRisk(candidates),
    stockSpecificMovers,
    scannedAt: Date.now(),
  };
}

// --- Book-level risk ---
// Each setup is sized independently to risk maxRiskPerTrade, and nothing
// ever looked at the resulting book. On a trending day every candidate is
// the same side of the same market, so taking 9 of them is not nine
// independent 2% bets — it's one directional bet at 9x size. DEFAULT_RISK_-
// CONFIG has declared maxDailyLoss and maxPositions from the start but no
// code read either of them; this is where they finally bind.
function computePortfolioRisk(candidates: ScannedCandidate[]): ScanPortfolioRisk {
  const capital = DEFAULT_RISK_CONFIG.tradingCapital;
  const maxPositions = DEFAULT_RISK_CONFIG.maxPositions;
  const maxDailyLoss = DEFAULT_RISK_CONFIG.maxDailyLoss;

  const sized = candidates.filter((c) => c.tradeSetup.positionSize && c.tradeSetup.positionSize.lots > 0);
  const totalRiskAmount = round2(sized.reduce((sum, c) => sum + (c.tradeSetup.positionSize?.riskAmount ?? 0), 0));
  const totalPremiumOutlay = round2(sized.reduce((sum, c) => sum + (c.tradeSetup.positionSize?.premiumOutlay ?? 0), 0));
  const sides = new Set(sized.map((c) => c.side));
  const singleSided = sides.size === 1 && sized.length > 1;

  // Walk the ranked list and count how many fit before either limit binds.
  let running = 0;
  let withinLimits = 0;
  for (const c of sized) {
    const risk = c.tradeSetup.positionSize?.riskAmount ?? 0;
    if (withinLimits >= maxPositions || running + risk > maxDailyLoss) break;
    running += risk;
    withinLimits += 1;
  }

  const warnings: string[] = [];
  if (sized.length > maxPositions) {
    warnings.push(`${sized.length} setups surfaced but maxPositions is ${maxPositions} — only the top ${maxPositions} fit your own risk config.`);
  }
  if (totalRiskAmount > maxDailyLoss) {
    warnings.push(
      `Taking all ${sized.length} risks ₹${totalRiskAmount.toFixed(0)} against a ₹${maxDailyLoss} daily loss limit — the first ${withinLimits} stay inside it.`
    );
  }
  if (singleSided) {
    warnings.push(
      `All ${sized.length} setups are ${[...sides][0]} — these are one correlated directional bet, not ${sized.length} independent ones. Size the book, not each trade.`
    );
  }
  if (totalPremiumOutlay > capital * 0.25) {
    warnings.push(
      `₹${totalPremiumOutlay.toFixed(0)} of premium (${round2((totalPremiumOutlay / capital) * 100)}% of capital) to open all of these — a gap through the stops loses the premium, not the stop-based risk.`
    );
  }

  return {
    positions: sized.length,
    maxPositions,
    totalRiskAmount,
    totalRiskPct: capital > 0 ? round2((totalRiskAmount / capital) * 100) : 0,
    maxDailyLoss,
    totalPremiumOutlay,
    totalPremiumPct: capital > 0 ? round2((totalPremiumOutlay / capital) * 100) : 0,
    singleSided,
    withinLimits,
    warnings,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function getMarketScan(provider: MarketDataProvider, exchange: Exchange = 'NSE'): Promise<MarketScanResult> {
  return cached(SCAN_CACHE_KEY, SCAN_CACHE_TTL_SECONDS, () => runMarketScan(provider, exchange));
}

// --- Background job ---

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 30_000;

let scannerStarted = false;

export function startMarketScanner(provider: MarketDataProvider): void {
  if (scannerStarted) return;
  scannerStarted = true;

  const tick = () => {
    if (!provider.isAuthenticated() || !isMarketOpen('NSE')) return;
    runMarketScan(provider)
      .then((result) =>
        // Write straight into the same cache key `getMarketScan` reads — an
        // API request between ticks gets this fresh result instead of
        // recomputing (cached() would only recompute once the TTL expires,
        // so this keeps the two paths' data in lockstep).
        redis.set(SCAN_CACHE_KEY, JSON.stringify(result), 'EX', SCAN_CACHE_TTL_SECONDS)
      )
      .catch((err: any) => logger.error({ error: err.message }, 'Market scanner tick failed'));
  };

  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, SCAN_INTERVAL_MS);
  logger.info({ intervalMs: SCAN_INTERVAL_MS }, 'Market scanner started');
}
