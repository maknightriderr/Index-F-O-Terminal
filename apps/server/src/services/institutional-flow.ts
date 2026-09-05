// ============================================================
// INSTITUTIONAL FLOW INTELLIGENCE
// ============================================================
// Sentiment composite + next-day bias engine, built from data this app
// can get live from Angel One (India VIX, NIFTY/BANKNIFTY PCR + expected
// move via the option-chain engine, NIFTY/BANKNIFTY futures OI, and
// F&O-universe-wide futures/PCR aggregates) plus NSE's own daily FII/DII
// cash-activity figures (see fii-dii.ts — unofficial endpoint, EOD-only,
// can go unavailable if NSE changes it). Participant-wise OI, FII futures
// positioning, and global-market inputs (USDINR/DXY/S&P500/Nasdaq/Dow/
// GIFT Nifty/Asian markets) are still NSE-report or global-feed data
// this app has no source for — every read below discloses exactly which
// real inputs it used via availableInputs/unavailableInputs rather than
// silently omitting or faking them.
// ============================================================

import type {
  Exchange,
  InstitutionalFlowSnapshot,
  NextDayBias,
  InstitutionalCommentary,
  SentimentLabel,
  MarketRegime,
  BiasDirection,
  OIInterpretation,
  MarketBias,
} from '@fno/shared';
import { getOIDescription } from '@fno/analytics';
import type { MarketDataProvider } from '../providers/interface.js';
import { getLiveIndexQuotes } from './indices.js';
import { buildOptionChain } from './option-chain.js';
import { buildFuturesData } from './futures.js';
import { scanFnoUniverse } from './fno-scanner.js';
import { buildMarketBias } from './market-bias.js';
import { getFiiDiiActivity } from './fii-dii.js';
import { cached } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import { askClaude, isAnthropicConfigured } from '../lib/anthropic.js';

const SCANNER_CACHE_TTL_SECONDS = 180; // shares fno-scanner.ts's own cache key/TTL with the rest of the app
export const INSTITUTIONAL_SYMBOLS: Array<{ symbol: string; exchange: Exchange }> = [
  { symbol: 'NIFTY', exchange: 'NSE' },
  { symbol: 'BANKNIFTY', exchange: 'NSE' },
];

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// --- Section 4: Smart Sentiment Engine ---

export async function buildSentimentSnapshot(provider: MarketDataProvider): Promise<InstitutionalFlowSnapshot> {
  const availableInputs: string[] = [];
  const unavailableInputs: string[] = [
    'USDINR',
    'DXY',
    'Global Crude Oil (WTI/Brent)',
    'US Market Performance (S&P 500 / Nasdaq / Dow)',
    'Asian Market Performance',
    'GIFT Nifty',
  ];

  const [vixQuotes, chains, futuresData, universe, fiiDii] = await Promise.all([
    getLiveIndexQuotes(provider, [{ symbol: 'INDIAVIX', exchange: 'NSE' }]).catch(() => []),
    Promise.all(
      INSTITUTIONAL_SYMBOLS.map((s) =>
        buildOptionChain(provider, s.symbol, s.exchange).catch((err) => {
          logger.warn({ error: err.message, symbol: s.symbol }, 'Institutional flow: option chain unavailable');
          return null;
        })
      )
    ),
    Promise.all(
      INSTITUTIONAL_SYMBOLS.map((s) =>
        buildFuturesData(provider, s.symbol, s.exchange).catch((err) => {
          logger.warn({ error: err.message, symbol: s.symbol }, 'Institutional flow: futures data unavailable');
          return null;
        })
      )
    ),
    cached('fno-scanner:NSE', SCANNER_CACHE_TTL_SECONDS, () => scanFnoUniverse(provider, 'NSE')).catch((err) => {
      logger.warn({ error: err.message }, 'Institutional flow: F&O universe scan unavailable');
      return [];
    }),
    getFiiDiiActivity(),
  ]);

  const vix = vixQuotes[0] ? { value: vixQuotes[0].ltp, changePercent: vixQuotes[0].changePercent } : null;
  if (vix) availableInputs.push('India VIX');
  else unavailableInputs.unshift('India VIX');

  if (fiiDii) availableInputs.push('FII/DII Cash Activity');
  else unavailableInputs.unshift('FII/DII Cash Activity');

  const niftyChain = chains[0];
  const bankNiftyChain = chains[1];
  const niftyPcr = niftyChain?.pcr ?? null;
  const bankNiftyPcr = bankNiftyChain?.pcr ?? null;
  if (niftyPcr != null || bankNiftyPcr != null) availableInputs.push('NIFTY/BANKNIFTY PCR');
  else unavailableInputs.unshift('NIFTY/BANKNIFTY PCR');

  const indexFuturesLean = futuresData.flatMap((f, i) => {
    const current = f?.contracts.find((c) => c.expiryLabel === 'current');
    if (!current) return [];
    return [{ symbol: INSTITUTIONAL_SYMBOLS[i].symbol, interpretation: current.interpretation, changeOiPercent: current.oi > 0 ? (current.changeOi / current.oi) * 100 : 0 }];
  });
  if (indexFuturesLean.length > 0) availableInputs.push('NIFTY/BANKNIFTY Index Futures OI');
  else unavailableInputs.unshift('NIFTY/BANKNIFTY Index Futures OI');

  const buildupCounts = { longBuildup: 0, shortBuildup: 0, shortCovering: 0, longUnwinding: 0, neutral: 0, total: universe.length };
  for (const row of universe) {
    switch (row.oiInterpretation) {
      case 'LONG_BUILDUP': buildupCounts.longBuildup++; break;
      case 'SHORT_BUILDUP': buildupCounts.shortBuildup++; break;
      case 'SHORT_COVERING': buildupCounts.shortCovering++; break;
      case 'LONG_UNWINDING': buildupCounts.longUnwinding++; break;
      default: buildupCounts.neutral++;
    }
  }
  if (universe.length > 0) availableInputs.push('F&O Universe Stock Futures OI');
  else unavailableInputs.unshift('F&O Universe Stock Futures OI');

  const pcrSamples = universe.filter((r) => r.pcr > 0);
  const putHeavy = pcrSamples.filter((r) => r.pcr > 1.1).length;
  const callHeavy = pcrSamples.filter((r) => r.pcr < 0.85).length;
  const optionOiLean = pcrSamples.length > 0
    ? { putHeavyPct: Math.round((putHeavy / pcrSamples.length) * 100), callHeavyPct: Math.round((callHeavy / pcrSamples.length) * 100), sampledSymbols: pcrSamples.length }
    : null;
  if (optionOiLean) availableInputs.push('F&O Universe Option OI Skew');
  else unavailableInputs.unshift('F&O Universe Option OI Skew');

  // --- Component scores (0-100, 50 = neutral), same scale/spirit as
  // market-bias.ts's contribution()/pcrScore so a "70" means the same
  // thing across every score in this app. ---
  // Weighted, not a plain average — VIX and index futures OI are direct,
  // single-instrument reads of market-wide institutional positioning;
  // the F&O-universe buildup counts and option-OI skew are much noisier,
  // heterogeneous aggregations across dozens of unrelated stocks, where
  // one stock's earnings-driven move can swing the aggregate independent
  // of anything actually institutional. An unweighted average let that
  // noisier pair dilute a clean VIX+index-futures signal just as much as
  // strengthening it. Weights only matter relative to each other — the
  // weighted-mean formula below naturally renormalizes over whichever
  // subset is actually available, so a missing input doesn't need
  // special-casing.
  const WEIGHT = { vix: 30, indexFutures: 30, fiiDii: 25, blendedPcr: 20, stockBuildup: 12, optionOiSkew: 8 };
  const scores: Array<{ value: number; weight: number }> = [];
  const reasoning: string[] = [];

  if (vix) {
    const vixScore = clamp(Math.round(100 - (vix.value - 10) * 4), 0, 100);
    scores.push({ value: vixScore, weight: WEIGHT.vix });
    reasoning.push(`India VIX at ${vix.value.toFixed(2)} (${vix.changePercent >= 0 ? '+' : ''}${vix.changePercent.toFixed(2)}%) — ${vixScore >= 60 ? 'calm, bullish-friendly' : vixScore <= 40 ? 'elevated, risk-off' : 'moderate'}`);
  }

  const avgPcr = [niftyPcr, bankNiftyPcr].filter((v): v is number => v != null);
  if (avgPcr.length > 0) {
    const pcr = avgPcr.reduce((a, b) => a + b, 0) / avgPcr.length;
    const pcrScore = clamp(Math.round(50 + (pcr - 1) * 40), 0, 100);
    scores.push({ value: pcrScore, weight: WEIGHT.blendedPcr });
    reasoning.push(`NIFTY/BANKNIFTY blended PCR at ${pcr.toFixed(2)} — ${pcr > 1.1 ? 'put-heavy, bullish lean' : pcr < 0.85 ? 'call-heavy, bearish lean' : 'balanced'}`);
  }

  if (indexFuturesLean.length > 0) {
    const idxScore = Math.round(
      indexFuturesLean.reduce((sum, f) => sum + implicationScore(f.interpretation), 0) / indexFuturesLean.length
    );
    scores.push({ value: idxScore, weight: WEIGHT.indexFutures });
    reasoning.push(`Index futures OI: ${indexFuturesLean.map((f) => `${f.symbol} ${getOIDescription(f.interpretation).description.split(' — ')[0]}`).join(', ')}`);
  }

  if (buildupCounts.total > 0) {
    const net = buildupCounts.longBuildup + buildupCounts.shortCovering - buildupCounts.shortBuildup - buildupCounts.longUnwinding;
    const stockScore = clamp(Math.round(50 + (net / buildupCounts.total) * 100), 0, 100);
    scores.push({ value: stockScore, weight: WEIGHT.stockBuildup });
    reasoning.push(
      `F&O universe (${buildupCounts.total} stocks): ${buildupCounts.longBuildup} long buildup, ${buildupCounts.shortBuildup} short buildup, ${buildupCounts.shortCovering} short covering, ${buildupCounts.longUnwinding} long unwinding`
    );
  }

  if (optionOiLean) {
    const oiScore = clamp(Math.round(50 + (optionOiLean.putHeavyPct - optionOiLean.callHeavyPct)), 0, 100);
    scores.push({ value: oiScore, weight: WEIGHT.optionOiSkew });
    reasoning.push(`Option OI skew across ${optionOiLean.sampledSymbols} stocks: ${optionOiLean.putHeavyPct}% put-heavy, ${optionOiLean.callHeavyPct}% call-heavy`);
  }

  // FII/DII net combined cash flow: ₹5,000 Cr net either way maps to the
  // score's 0/100 extreme — a big single-session net is a real, high-
  // conviction institutional signal on Indian markets, comparable in
  // weight to VIX/index futures OI, not a minor secondary input. This is
  // NSE's last-published figure (see fii-dii.ts) — same-day only once NSE
  // has actually published it, otherwise still the prior session's.
  const netFiiDiiCr = fiiDii ? fiiDii.fii.netValue + fiiDii.dii.netValue : null;
  if (netFiiDiiCr != null) {
    const fiiDiiScore = clamp(Math.round(50 + (netFiiDiiCr / 5000) * 50), 0, 100);
    scores.push({ value: fiiDiiScore, weight: WEIGHT.fiiDii });
    reasoning.push(
      `FII/DII combined net ₹${netFiiDiiCr >= 0 ? '+' : ''}${netFiiDiiCr.toFixed(0)} Cr on ${fiiDii!.date} (FII ${fiiDii!.fii.netValue >= 0 ? '+' : ''}${fiiDii!.fii.netValue.toFixed(0)} Cr, DII ${fiiDii!.dii.netValue >= 0 ? '+' : ''}${fiiDii!.dii.netValue.toFixed(0)} Cr)`
    );
  }

  const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
  const sentimentScore = totalWeight > 0 ? clamp(Math.round(scores.reduce((sum, s) => sum + s.value * s.weight, 0) / totalWeight), 0, 100) : 50;
  const sentimentLabel = classifySentiment(sentimentScore);

  const overallLean = sentimentScore > 60 ? 1 : sentimentScore < 40 ? -1 : 0;
  const agreeing = scores.filter((s) => (overallLean === 1 && s.value > 55) || (overallLean === -1 && s.value < 45) || (overallLean === 0 && s.value >= 40 && s.value <= 60)).length;
  const confidenceScore = scores.length > 0 ? clamp(Math.round((agreeing / scores.length) * 100), 10, 95) : 10;

  // Magnitude, not direction — a big net flow either way means conviction,
  // near-zero means institutions are on the sidelines. Same ₹5,000 Cr
  // scale as the sentiment score's own FII/DII component above.
  const institutionalConvictionScore = netFiiDiiCr != null ? clamp(Math.round((Math.abs(netFiiDiiCr) / 5000) * 100), 0, 100) : null;

  reasoning.push(
    `Sentiment score is a weighted average of ${scores.length} available input${scores.length === 1 ? '' : 's'} (VIX, index futures OI, and FII/DII flow weighted highest as direct market-wide reads) — ${unavailableInputs.length} more (global markets) aren't connected yet and are excluded rather than estimated.`
  );

  return {
    vix,
    niftyPcr,
    bankNiftyPcr,
    indexFuturesLean,
    stockFuturesBuildup: buildupCounts,
    optionOiLean,
    fiiDii,
    sentimentScore,
    sentimentLabel,
    confidenceScore,
    institutionalConvictionScore,
    sentimentReasoning: reasoning,
    availableInputs,
    unavailableInputs,
    timestamp: Date.now(),
  };
}

function implicationScore(interpretation: OIInterpretation): number {
  const { implication } = getOIDescription(interpretation);
  return implication === 'BULLISH' ? 80 : implication === 'BEARISH' ? 20 : 50;
}

function classifySentiment(score: number): SentimentLabel {
  if (score <= 20) return 'EXTREMELY_BEARISH';
  if (score <= 40) return 'BEARISH';
  if (score <= 60) return 'NEUTRAL';
  if (score <= 80) return 'BULLISH';
  return 'EXTREMELY_BULLISH';
}

// --- Section 5: Next-Day Market Bias Engine ---
// Every probability here is a transparent, documented derivation from
// the existing market-bias engine's direction/confidence/regime plus
// India VIX — not a statistical model trained on historical outcomes
// (that would need the years of resolved predictions this app is only
// just starting to collect; see institutional-flow-scanner.ts).

const TREND_BASE_BY_REGIME: Record<MarketRegime, number> = {
  STRONG_BULL_TREND: 72,
  STRONG_BEAR_TREND: 72,
  WEAK_BULL_TREND: 55,
  WEAK_BEAR_TREND: 55,
  HIGH_VOLATILITY: 50,
  LOW_VOLATILITY: 32,
  RANGE_BOUND: 28,
  BREAKOUT: 75,
  BREAKDOWN: 75,
  EXPIRY_GAMMA: 40,
  OPERATOR_ACCUMULATION: 78,
  OPERATOR_DISTRIBUTION: 78,
};

export async function buildNextDayBias(provider: MarketDataProvider, symbol: string): Promise<NextDayBias> {
  const [{ bias }, vixQuotes] = await Promise.all([
    buildMarketBias(provider, symbol, 'NSE'),
    getLiveIndexQuotes(provider, [{ symbol: 'INDIAVIX', exchange: 'NSE' }]).catch(() => []),
  ]);
  return deriveNextDayBias(symbol, bias, vixQuotes[0]?.ltp ?? null);
}

/**
 * Pure derivation from an already-fetched MarketBias + VIX reading — split
 * out from buildNextDayBias so the prediction-tracking scanner (which
 * needs the raw MarketBias anyway, for bullish/bearish/neutral probability
 * columns) can reuse the exact same formula instead of a second, possibly
 * drifting copy of it.
 */
export function deriveNextDayBias(symbol: string, bias: MarketBias, vix: number | null): NextDayBias {
  const inputs = bias.inputs as Record<string, number | string | null>;
  const expectedRangeLow = Number(inputs.expectedRangeLow ?? 0);
  const expectedRangeHigh = Number(inputs.expectedRangeHigh ?? 0);

  const trendBase = TREND_BASE_BY_REGIME[bias.regime] ?? 45;
  const trendDayProbability = clamp(Math.round(trendBase * (0.6 + (bias.confidence / 100) * 0.4)), 5, 95);
  const rangeBoundProbability = clamp(100 - trendDayProbability, 5, 95);

  const vixBase = vix == null ? 40 : vix < 12 ? 15 : vix < 18 ? 30 : vix < 25 ? 55 : vix < 32 ? 75 : 90;
  const volatileSessionProbability = clamp(bias.regime === 'HIGH_VOLATILITY' ? Math.min(95, vixBase + 15) : vixBase, 5, 95);

  const { gapUp, gapDown } = computeGapProbabilities(bias.direction, bias.confidence);

  const reasoning: string[] = [
    `${bias.direction} bias at ${bias.confidence}/100 confidence, regime ${bias.regime.replace(/_/g, ' ').toLowerCase()}`,
    expectedRangeLow > 0 && expectedRangeHigh > 0
      ? `Expected range from ATM IV: ${expectedRangeLow.toFixed(0)}–${expectedRangeHigh.toFixed(0)}`
      : 'Expected range unavailable — option chain data incomplete this tick',
    vix != null ? `India VIX at ${vix.toFixed(2)}` : 'India VIX unavailable this tick',
    'Probabilities are a transparent rule-based read of current regime/confidence/VIX — not a statistical model trained on historical outcomes.',
  ];

  return {
    symbol,
    gapUpProbability: gapUp,
    gapDownProbability: gapDown,
    trendDayProbability,
    rangeBoundProbability,
    volatileSessionProbability,
    expectedRangeLow,
    expectedRangeHigh,
    predictedDirection: bias.direction,
    confidence: bias.confidence,
    reasoning,
    timestamp: Date.now(),
  };
}

function computeGapProbabilities(direction: BiasDirection, confidence: number): { gapUp: number; gapDown: number } {
  if (direction === 'NEUTRAL') return { gapUp: 50, gapDown: 50 };
  const lean = clamp(8 + (confidence / 100) * 32, 8, 40);
  const gapUp = Math.round(direction === 'BULLISH' ? 50 + lean : 50 - lean);
  return { gapUp, gapDown: 100 - gapUp };
}

// --- Section 6: AI Market Commentary ---
// Reuses the same Claude integration as the AI Assistant tab, grounded
// ONLY in the real snapshot/bias data computed above — explicitly told
// not to reference FII/DII flows or global markets since none of that
// is in the grounding context.

const COMMENTARY_SYSTEM_PROMPT = `You are an institutional flow analyst inside a personal F&O trading terminal for Indian markets (NSE/BSE/MCX). You will be given a live data snapshot — India VIX, NIFTY/BANKNIFTY PCR, index/stock futures OI activity, option OI skew, and a rule-based next-day bias read for NIFTY and BANKNIFTY. Some inputs (FII/DII cash flows, participant-wise OI, global markets) are explicitly listed as NOT connected — never reference them, invent figures for them, or imply they were considered. Use ONLY the numbers given. This is data summarization, not investment advice — never phrase output as a recommendation to buy or sell.

Respond with ONLY a JSON object, no markdown fences, no other text, in exactly this shape:
{"oneLineSummary": "...", "detailedAnalysis": "...", "bullCase": "...", "bearCase": "...", "riskFactors": ["...", "..."]}

oneLineSummary: one sentence, the single most important takeaway.
detailedAnalysis: 2-4 sentences synthesizing the snapshot.
bullCase: 1-2 sentences on what would validate a bullish read.
bearCase: 1-2 sentences on what would validate a bearish read.
riskFactors: 2-4 short bullet-style strings on what could invalidate this read.`;

export async function generateCommentary(snapshot: InstitutionalFlowSnapshot, biases: NextDayBias[]): Promise<InstitutionalCommentary> {
  if (!isAnthropicConfigured()) {
    return {
      oneLineSummary: 'AI commentary unavailable — ANTHROPIC_API_KEY not configured on the backend.',
      detailedAnalysis: '',
      bullCase: '',
      bearCase: '',
      riskFactors: [],
      generatedAt: Date.now(),
    };
  }

  const lines: string[] = [];
  lines.push(`Sentiment: ${snapshot.sentimentScore}/100 (${snapshot.sentimentLabel.replace(/_/g, ' ')}), confidence ${snapshot.confidenceScore}/100.`);
  if (snapshot.vix) lines.push(`India VIX: ${snapshot.vix.value.toFixed(2)} (${snapshot.vix.changePercent >= 0 ? '+' : ''}${snapshot.vix.changePercent.toFixed(2)}%).`);
  if (snapshot.niftyPcr != null) lines.push(`NIFTY PCR: ${snapshot.niftyPcr.toFixed(2)}.`);
  if (snapshot.bankNiftyPcr != null) lines.push(`BANKNIFTY PCR: ${snapshot.bankNiftyPcr.toFixed(2)}.`);
  for (const f of snapshot.indexFuturesLean) lines.push(`${f.symbol} futures OI: ${getOIDescription(f.interpretation).description}.`);
  if (snapshot.stockFuturesBuildup.total > 0) {
    const b = snapshot.stockFuturesBuildup;
    lines.push(`F&O universe (${b.total} stocks): ${b.longBuildup} long buildup, ${b.shortBuildup} short buildup, ${b.shortCovering} short covering, ${b.longUnwinding} long unwinding.`);
  }
  if (snapshot.optionOiLean) lines.push(`Option OI skew: ${snapshot.optionOiLean.putHeavyPct}% of ${snapshot.optionOiLean.sampledSymbols} stocks put-heavy, ${snapshot.optionOiLean.callHeavyPct}% call-heavy.`);
  for (const b of biases) {
    lines.push(
      `${b.symbol} next-day bias: ${b.predictedDirection} (confidence ${b.confidence}), gap-up ${b.gapUpProbability}% / gap-down ${b.gapDownProbability}%, trend-day ${b.trendDayProbability}%, expected range ${b.expectedRangeLow.toFixed(0)}-${b.expectedRangeHigh.toFixed(0)}.`
    );
  }
  lines.push(`NOT connected (never reference): ${snapshot.unavailableInputs.join(', ')}.`);

  try {
    const raw = await askClaude(COMMENTARY_SYSTEM_PROMPT, [{ role: 'user', content: lines.join('\n') }]);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    return {
      oneLineSummary: String(parsed.oneLineSummary ?? ''),
      detailedAnalysis: String(parsed.detailedAnalysis ?? ''),
      bullCase: String(parsed.bullCase ?? ''),
      bearCase: String(parsed.bearCase ?? ''),
      riskFactors: Array.isArray(parsed.riskFactors) ? parsed.riskFactors.map(String) : [],
      generatedAt: Date.now(),
    };
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Institutional flow: AI commentary generation failed');
    return {
      oneLineSummary: 'AI commentary temporarily unavailable.',
      detailedAnalysis: '',
      bullCase: '',
      bearCase: '',
      riskFactors: [],
      generatedAt: Date.now(),
    };
  }
}
