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
  OIInterpretation,
} from '@fno/shared';
import { KNOWN_INDEX_TOKENS, getSessionWindow } from '@fno/shared';
import {
  NEXT_DAY_MODEL_VERSION,
  GAP_THRESHOLD_PCT,
  VOLATILE_RANGE_MULTIPLE,
  TREND_BODY_SHARE,
  toDailyBars,
  estimateNextDay,
  nextSessionDate,
  calendarDaysToNextClose,
  describeLocation,
  describeRange,
} from './next-day-model.js';
import type { DailyBar } from './next-day-model.js';
import { getOIDescription } from '@fno/analytics';
import type { MarketDataProvider } from '../providers/interface.js';
import { getLiveIndexQuotes } from './indices.js';
import { buildOptionChain } from './option-chain.js';
import { buildFuturesData } from './futures.js';
import { getFnoScan } from './fno-scanner.js';
import { buildMarketBias } from './market-bias.js';
import { getFiiDiiActivity } from './fii-dii.js';
import { cached } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import { askClaude, isAnthropicConfigured } from '../lib/anthropic.js';

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
    getFnoScan(provider, 'NSE').catch((err) => {
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
// Empirical, not rule-based: every figure is a rate measured over the
// trailing ~250 NSE sessions of this index's own daily candles, and nothing
// is stated where history showed no edge. See next-day-model.ts for the
// out-of-sample research behind each choice (in short: no direction call,
// gap odds by close location, volatile-session odds by today's range,
// trend-day base rate, ±1σ ATM-IV close range).

const DAILY_HISTORY_CALENDAR_DAYS = 420;
const DAILY_HISTORY_CACHE_SECONDS = 5 * 60;

function istDateOffset(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Daily bars for an index, oldest first. `fresh` skips the cache — the tracking scanner stores a final prediction from it. */
export async function getDailyBars(provider: MarketDataProvider, symbol: string, fresh = false): Promise<DailyBar[]> {
  const token = KNOWN_INDEX_TOKENS[symbol as keyof typeof KNOWN_INDEX_TOKENS];
  if (!token) throw new Error(`No index token for ${symbol}`);
  const load = async () =>
    toDailyBars(
      await provider.getHistoricalData({
        exchange: 'NSE',
        token,
        interval: 'ONE_DAY',
        fromDate: `${istDateOffset(-DAILY_HISTORY_CALENDAR_DAYS)} 09:15`,
        toDate: `${istDateOffset(0)} 15:30`,
      })
    );
  if (fresh) return load();
  return cached(`next-day:daily:${symbol}`, DAILY_HISTORY_CACHE_SECONDS, load, (bars) => bars.length > 0);
}

/**
 * ATM IV (%) for the next-day range. Skips an expiring chain: on its expiry
 * day the nearest contract's IV describes the last hours, not tomorrow.
 */
async function nextDayAtmIv(provider: MarketDataProvider, symbol: string): Promise<number | null> {
  let chain = await buildOptionChain(provider, symbol, 'NSE');
  if (chain.dte === 0 && chain.availableExpiries.length > 1) {
    chain = await buildOptionChain(provider, symbol, 'NSE', chain.availableExpiries[1]);
  }
  const atm = chain.strikes.find((st) => st.strike === chain.atmStrike);
  const samples = [atm?.call?.iv, atm?.put?.iv].filter((v): v is number => v != null && v > 0);
  return samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
}

export async function buildNextDayBias(provider: MarketDataProvider, symbol: string, opts: { freshHistory?: boolean } = {}): Promise<NextDayBias> {
  const [bars, atmIvPct] = await Promise.all([
    getDailyBars(provider, symbol, opts.freshHistory),
    nextDayAtmIv(provider, symbol).catch((err: any) => {
      logger.warn({ error: err.message, symbol }, 'Next-day bias: ATM IV unavailable, range omitted');
      return null;
    }),
  ]);
  const estimate = estimateNextDay(bars);
  if (!estimate) throw new Error(`Not enough daily history for ${symbol} (${bars.length} bars)`);

  const basis = bars[bars.length - 1];
  const today = istDateOffset(0);
  const todaySession = getSessionWindow('NSE', today);
  const basisFinal = basis.date < today || !todaySession || Date.now() >= todaySession.close;
  const horizonDays = calendarDaysToNextClose(basis.date);
  const expectedMovePoints =
    atmIvPct != null ? Math.round(basis.close * (atmIvPct / 100) * Math.sqrt(horizonDays / 365) * 100) / 100 : null;
  const nextSession = nextSessionDate(basis.date);

  const reasoning = [
    'No direction call: across 2023–2026 daily history, none of 12 tested price rules (trend, momentum, reversal, RSI, close location) predicted the next close’s direction out of sample.',
    `Opening gap for ${nextSession}: over the last ${estimate.gapSample} sessions the next open was ≥${GAP_THRESHOLD_PCT}% above the prior close ${estimate.gapUpPct}% of the time, below it ${estimate.gapDownPct}%, and flat ${estimate.flatOpenPct}%. Where the day closed in its range (${describeLocation(estimate.closeLocation)} on ${basis.date}${basisFinal ? '' : ', so far'}) tilts this slightly, but using it didn’t improve accuracy out of sample, so these are plain base rates.`,
    `Volatile session: ${basis.date}’s range is ${describeRange(estimate.rangeBucket)} vs its 20-day average${basisFinal ? '' : ' so far'}. After ${estimate.volatileConditioned ? `such days (${estimate.volatileSample} sessions)` : `all ${estimate.volatileSample} sessions`}, the next range exceeded ${VOLATILE_RANGE_MULTIPLE}× that average about ${estimate.volatilePct}% of the time. Volatility clusters, and this read held out of sample.`,
    `Trend day (close–open ≥ ${Math.round(TREND_BODY_SHARE * 100)}% of the range): ${estimate.trendDayPct}% of the last ${estimate.trendSample} sessions; no tested condition changed that rate.`,
    expectedMovePoints != null && atmIvPct != null
      ? `Expected close range: ±${expectedMovePoints.toFixed(0)} pts (1σ from ATM IV ${atmIvPct.toFixed(1)}% over ${horizonDays.toFixed(1)} calendar day${horizonDays >= 1.5 ? 's' : ''}) — the close should land inside about 68% of the time if IV is fair.`
      : 'Expected close range unavailable — no usable ATM IV this read.',
  ];
  if (!basisFinal) reasoning.push('Preview: the basis session is still trading, so these figures move until its close; the tracked prediction is recorded after it.');

  return {
    symbol,
    gapUpProbability: estimate.gapUpPct,
    gapDownProbability: estimate.gapDownPct,
    flatOpenProbability: estimate.flatOpenPct,
    trendDayProbability: estimate.trendDayPct,
    rangeBoundProbability: 100 - estimate.trendDayPct,
    volatileSessionProbability: estimate.volatilePct,
    expectedRangeLow: expectedMovePoints != null ? Math.round((basis.close - expectedMovePoints) * 100) / 100 : 0,
    expectedRangeHigh: expectedMovePoints != null ? Math.round((basis.close + expectedMovePoints) * 100) / 100 : 0,
    predictedDirection: 'NEUTRAL',
    confidence: 0,
    reasoning,
    timestamp: Date.now(),
    model: NEXT_DAY_MODEL_VERSION,
    evidence: {
      basisDate: basis.date,
      basisFinal,
      basisClose: basis.close,
      closeLocation: estimate.closeLocation,
      rangeBucket: estimate.rangeBucket,
      gapSample: estimate.gapSample,
      trendSample: estimate.trendSample,
      volatileSample: estimate.volatileSample,
      volatileConditioned: estimate.volatileConditioned,
      atmIvPct: atmIvPct != null ? Math.round(atmIvPct * 100) / 100 : null,
      expectedMovePoints,
      horizonDays: Math.round(horizonDays * 100) / 100,
    },
  };
}

// --- Section 6: AI Market Commentary ---
// Reuses the same Claude integration as the AI Assistant tab, grounded
// ONLY in the real snapshot/bias data computed above — explicitly told
// not to reference FII/DII flows or global markets since none of that
// is in the grounding context.

const COMMENTARY_SYSTEM_PROMPT = `You are an institutional flow analyst inside a personal F&O trading terminal for Indian markets (NSE/BSE/MCX). You will be given a live data snapshot — India VIX, NIFTY/BANKNIFTY PCR, index/stock futures OI activity, option OI skew, and empirical next-session odds for NIFTY and BANKNIFTY (gap, volatility and trend-day rates from daily history, deliberately with no direction call). Some inputs (FII/DII cash flows, participant-wise OI, global markets) are explicitly listed as NOT connected — never reference them, invent figures for them, or imply they were considered. Use ONLY the numbers given. This is data summarization, not investment advice — never phrase output as a recommendation to buy or sell.

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
      `${b.symbol} next session (no direction call, history shows no edge): gap-up ${b.gapUpProbability}% / gap-down ${b.gapDownProbability}% / flat ${b.flatOpenProbability ?? '-'}%, volatile session ${b.volatileSessionProbability}%, trend day ${b.trendDayProbability}%${b.expectedRangeLow > 0 ? `, expected close range ${b.expectedRangeLow.toFixed(0)}-${b.expectedRangeHigh.toFixed(0)}` : ''}.`
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
