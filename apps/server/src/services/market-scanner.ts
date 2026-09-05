// ============================================================
// MARKET SCANNER
// ============================================================
// Automates the manual top-down workflow: read NIFTY/BANKNIFTY/VIX/
// breadth for overall market trend -> pick the single strongest sector
// when bullish (weakest when bearish) -> shortlist its top 5 liquid
// F&O stocks -> run the full per-symbol signal engine on each -> score
// every candidate 0-100 across 8 categories (Market Trend, Sector
// Strength, Price Action, EMA Trend, Volume, Option Chain, OI Buildup,
// SMC Structure) -> surface only the ones scoring >= 60.
//
// Deliberately reuses the existing per-symbol engine (buildMarketBias)
// rather than re-deriving RSI/VWAP/Supertrend/OI/SMC signals a second
// time — it already computes everything this scoring model needs, and
// is only called for a handful of finalist stocks per cycle (not the
// whole ~180-stock universe, which stays on fno-scanner.ts's lighter
// quote-only path for the initial ranking).
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
  ScannerScoreBreakdown,
  ScannerSetupTier,
  SectorRank,
} from '@fno/shared';
import { LIQUID_SPREAD_MAX_PCT, isMarketOpen } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { buildMarketBias } from './market-bias.js';
import { scanFnoUniverse } from './fno-scanner.js';
import { getLiveIndexQuotes } from './indices.js';
import { computeMarketBreadth } from './market-breadth.js';
import { rankSectors } from './sector-strength.js';
import { cached } from '../lib/cache.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const SHORTLIST_SIZE = 5;
const MIN_STOCK_VOLUME = 50_000; // floor beneath which a "liquid" spread reading isn't trustworthy either
const SCORE_SURFACE_FLOOR = 60; // spec's own "Weak setup, generally avoid" cutoff — nothing below this is shown at all
const NIFTY_TREND_MIN_CONFIDENCE = 55;

const SCAN_CACHE_KEY = 'market_scan:latest';
const SCAN_CACHE_TTL_SECONDS = 360; // a little over the 5-minute background interval, so the API never serves a fully-expired read

function tierFor(score: number): ScannerSetupTier {
  return score >= 80 ? 'HIGH_CONVICTION' : score >= 70 ? 'WATCHLIST' : 'WEAK';
}

// --- Step 1: overall market trend ---

async function assessMarketTrend(provider: MarketDataProvider, fnoRows: FnoScannerRow[]): Promise<MarketTrendRead> {
  const [{ bias: niftyBias }, { bias: bankNiftyBias }, vixQuotes] = await Promise.all([
    buildMarketBias(provider, 'NIFTY', 'NSE'),
    buildMarketBias(provider, 'BANKNIFTY', 'NSE'),
    getLiveIndexQuotes(provider, [{ symbol: 'INDIAVIX', exchange: 'NSE' }]).catch(() => []),
  ]);
  const vix = vixQuotes[0]?.ltp ?? null;
  const breadth = computeMarketBreadth(fnoRows);

  const niftyBullish = niftyBias.direction === 'BULLISH' && niftyBias.confidence >= NIFTY_TREND_MIN_CONFIDENCE;
  const niftyBearish = niftyBias.direction === 'BEARISH' && niftyBias.confidence >= NIFTY_TREND_MIN_CONFIDENCE;

  let trend: MarketTrend;
  const reasoning: string[] = [];
  if (niftyBullish && breadth.isBullishBias) {
    trend = 'BULLISH';
    reasoning.push(`NIFTY bullish at ${niftyBias.confidence}% confidence, breadth favors advances (${breadth.advances} vs ${breadth.declines})`);
  } else if (niftyBearish && !breadth.isBullishBias) {
    trend = 'BEARISH';
    reasoning.push(`NIFTY bearish at ${niftyBias.confidence}% confidence, breadth favors declines (${breadth.declines} vs ${breadth.advances})`);
  } else {
    trend = 'SIDEWAYS';
    reasoning.push(
      niftyBias.direction === 'NEUTRAL'
        ? 'NIFTY reading NEUTRAL — no clear directional lean'
        : `NIFTY ${niftyBias.direction.toLowerCase()} but only ${niftyBias.confidence}% confidence or breadth disagrees — not a clean market-wide trend`
    );
  }

  // Same VIX-score formula institutional-flow.ts already uses, for
  // consistency across the app: low VIX (calm) scores high, elevated VIX
  // (fear/uncertainty) scores low, clamped 0-100.
  const vixScore = vix != null ? Math.max(0, Math.min(100, 100 - (vix - 10) * 4)) : 50;
  const confidenceComponent = Math.round((niftyBias.confidence / 100) * 10);
  const breadthComponent = (trend === 'BULLISH' && breadth.isBullishBias) || (trend === 'BEARISH' && !breadth.isBullishBias) ? 3 : 0;
  const vixComponent = Math.round((vixScore / 100) * 2);
  const score = trend === 'SIDEWAYS' ? Math.round(confidenceComponent * 0.5) : Math.min(15, confidenceComponent + breadthComponent + vixComponent);

  if (vix != null) reasoning.push(`India VIX at ${vix.toFixed(2)}`);

  return { trend, score, niftyBias, bankNiftyBias, vix, breadth, reasoning };
}

// --- Step 2: sector + stock shortlist ---

function shortlistStocks(sector: SectorRank, fnoRows: FnoScannerRow[], trend: MarketTrend): FnoScannerRow[] {
  const rowBySymbol = new Map(fnoRows.map((r) => [r.symbol, r]));
  const liquid = sector.symbols
    .map((s) => rowBySymbol.get(s))
    .filter((r): r is FnoScannerRow => r != null && r.volume >= MIN_STOCK_VOLUME && (r.atmSpreadPct == null || r.atmSpreadPct <= LIQUID_SPREAD_MAX_PCT));

  liquid.sort((a, b) => (trend === 'BULLISH' ? b.relativeStrength - a.relativeStrength : a.relativeStrength - b.relativeStrength));
  return liquid.slice(0, SHORTLIST_SIZE);
}

// --- Step 3: per-candidate scoring ---

interface BiasInputsSubset {
  ema20: number | null;
  ema50: number | null;
  emaAligned: 'BULLISH' | 'BEARISH' | null;
  volumeRatio: number;
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
  side: OptionType
): { breakdown: ScannerScoreBreakdown; reasoning: string[] } {
  const wantsBullish = side === 'CE';
  const inputs = stockBias.inputs as unknown as BiasInputsSubset;
  const reasoning: string[] = [];

  // Market Trend: the shared step-1 score, but zeroed if this stock's own
  // read contradicts the market's preferred side — the spec's "market +
  // sector + stock alignment" requirement, not just "NIFTY is bullish
  // somewhere out there."
  const stockAgrees = (wantsBullish && stockBias.direction === 'BULLISH') || (!wantsBullish && stockBias.direction === 'BEARISH');
  const marketTrendScore = stockAgrees ? marketTrend.score : 0;
  if (!stockAgrees) reasoning.push(`Stock's own bias (${stockBias.direction}) doesn't confirm the market's ${marketTrend.trend} read — Market Trend score zeroed`);

  // Sector Strength: a clear sector leader (big gap over the next-ranked
  // sector) scores higher than a narrow win.
  const sectorStrengthScore = Math.min(10, Math.round(5 + Math.abs(sector.avgRelativeStrength) * 2));
  reasoning.push(`${sector.sector} sector relative strength ${sector.avgRelativeStrength > 0 ? '+' : ''}${sector.avgRelativeStrength}% vs NIFTY`);

  // Price Action / Setup: BREAKOUT/BREAKDOWN regime agreeing with side is
  // the strongest single read here (a leading, volume-confirmed signal);
  // chart-structure pattern agreement adds up to 6 more, scaled by its own
  // confidence rather than being all-or-nothing.
  let priceActionScore = 0;
  if ((wantsBullish && stockBias.regime === 'BREAKOUT') || (!wantsBullish && stockBias.regime === 'BREAKDOWN')) {
    priceActionScore += 10;
    reasoning.push(`Volume-confirmed ${stockBias.regime.toLowerCase()} regime agrees with ${side}`);
  }
  const patternDir = inputs.chartStructureLong?.direction ?? inputs.chartStructureShort?.direction ?? null;
  const patternConfidence = inputs.chartStructureLong?.confidence ?? inputs.chartStructureShort?.confidence ?? 0;
  if (patternDir === (wantsBullish ? 'BULLISH' : 'BEARISH')) {
    priceActionScore += Math.round((patternConfidence / 100) * 6);
    reasoning.push(`Chart structure pattern agrees with ${side} (${patternConfidence}% confidence)`);
  }
  if (inputs.lastStructureEvent && inputs.lastStructureEvent.direction === (wantsBullish ? 'BULLISH' : 'BEARISH')) {
    priceActionScore += inputs.lastStructureEvent.type === 'CHOCH' ? 4 : 2;
    reasoning.push(`${inputs.lastStructureEvent.type === 'CHOCH' ? 'Change of Character' : 'Break of Structure'} agrees with ${side}`);
  }
  priceActionScore = Math.min(20, priceActionScore);

  // EMA Trend: bias.inputs.emaAligned already folds in the slope check —
  // only counts if EMA20/EMA50 are genuinely stacked AND sloping this way,
  // not merely "price happens to be above them right now."
  const emaTrendScore = inputs.emaAligned === (wantsBullish ? 'BULLISH' : 'BEARISH') ? 10 : 0;
  if (emaTrendScore > 0) reasoning.push(`Price > EMA20 > EMA50 stacked and sloping ${side === 'CE' ? 'bullish' : 'bearish'}`);

  // Volume: current vs 20-bar average, already computed by market-bias.ts.
  const volumeScore = Math.max(0, Math.min(10, Math.round((inputs.volumeRatio - 1) * 10)));
  if (volumeScore > 0) reasoning.push(`Volume ${inputs.volumeRatio.toFixed(2)}x its 20-bar average`);

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

  // SMC Structure: BOS/CHoCH, liquidity sweep, FVG, order block — each
  // worth a slice, only when its direction agrees with this side.
  let smcStructureScore = 0;
  if (inputs.lastStructureEvent?.direction === (wantsBullish ? 'BULLISH' : 'BEARISH')) smcStructureScore += 3;
  if (inputs.liquiditySweep && (wantsBullish ? inputs.liquiditySweep.type === 'SELL_SIDE' : inputs.liquiditySweep.type === 'BUY_SIDE')) {
    smcStructureScore += 3;
    reasoning.push(`${inputs.liquiditySweep.type === 'SELL_SIDE' ? 'Sell-side' : 'Buy-side'} liquidity sweep agrees with ${side}`);
  }
  if (inputs.activeFvg?.type === (wantsBullish ? 'BULLISH' : 'BEARISH')) smcStructureScore += 2;
  if (inputs.activeOrderBlock?.type === (wantsBullish ? 'BULLISH' : 'BEARISH')) smcStructureScore += 2;
  smcStructureScore = Math.min(10, smcStructureScore);

  return {
    breakdown: {
      marketTrend: marketTrendScore,
      sectorStrength: sectorStrengthScore,
      priceAction: priceActionScore,
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
  return b.marketTrend + b.sectorStrength + b.priceAction + b.emaTrend + b.volume + b.optionChain + b.oiBuildup + b.smcStructure;
}

// --- Pipeline entry point ---

export async function runMarketScan(provider: MarketDataProvider, exchange: Exchange = 'NSE'): Promise<MarketScanResult> {
  const fnoRows = await scanFnoUniverse(provider, exchange);
  const marketTrend = await assessMarketTrend(provider, fnoRows);

  if (marketTrend.trend === 'SIDEWAYS') {
    return { marketTrend, sector: null, candidates: [], scannedAt: Date.now() };
  }

  const sectorRanks = rankSectors(fnoRows);
  const sector = marketTrend.trend === 'BULLISH' ? sectorRanks[0] : sectorRanks[sectorRanks.length - 1];
  if (!sector) {
    return { marketTrend, sector: null, candidates: [], scannedAt: Date.now() };
  }

  const shortlist = shortlistStocks(sector, fnoRows, marketTrend.trend);
  const side: OptionType = marketTrend.trend === 'BULLISH' ? 'CE' : 'PE';

  const candidates: ScannedCandidate[] = [];
  for (const row of shortlist) {
    try {
      const { bias, tradeSetup } = await buildMarketBias(provider, row.symbol, exchange);
      if (!tradeSetup.available) continue;

      const { breakdown, reasoning } = scoreCandidate(marketTrend, sector, bias, side);
      const score = sumBreakdown(breakdown);
      if (score < SCORE_SURFACE_FLOOR) continue;

      candidates.push({
        symbol: row.symbol,
        exchange,
        sector: sector.sector,
        side,
        score,
        tier: tierFor(score),
        scoreBreakdown: breakdown,
        tradeSetup,
        reasoning,
      });
    } catch (err: any) {
      logger.warn({ error: err.message, symbol: row.symbol }, 'Market scanner: one candidate failed, skipping');
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return { marketTrend, sector, candidates, scannedAt: Date.now() };
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
