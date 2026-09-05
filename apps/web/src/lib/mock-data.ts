// ============================================================
// MOCK DATA — For UI Development Only
// ============================================================
// This file provides mock data for developing UI components
// BEFORE live broker integration is active. All mock data is
// clearly isolated here. Replace with live data in Phase 2.
// ============================================================

import type {
  MarketQuote,
  MarketBias,
  IntelligenceScore,
  SystemHealth,
  FnoScannerRow,
  FiiDiiActivity,
  InstitutionalFlowSnapshot,
} from '@fno/shared';
import type { OptionChainSummary } from './use-option-chain-summary';

// --- Mock Index Quotes ---

export const MOCK_INDICES: MarketQuote[] = [
  {
    token: '99926000', symbol: 'NIFTY 50', exchange: 'NSE',
    ltp: 24620.35, change: 125.40, changePercent: 0.51,
    open: 24530.10, high: 24685.75, low: 24490.20, close: 24494.95,
    volume: 0, timestamp: Date.now(),
  },
  {
    token: '99926009', symbol: 'BANK NIFTY', exchange: 'NSE',
    ltp: 51240.80, change: -180.60, changePercent: -0.35,
    open: 51450.25, high: 51520.90, low: 51120.45, close: 51421.40,
    volume: 0, timestamp: Date.now(),
  },
  {
    token: '99919000', symbol: 'SENSEX', exchange: 'BSE',
    ltp: 80925.50, change: 342.15, changePercent: 0.42,
    open: 80650.30, high: 81050.80, low: 80520.10, close: 80583.35,
    volume: 0, timestamp: Date.now(),
  },
  {
    token: '99926037', symbol: 'FINNIFTY', exchange: 'NSE',
    ltp: 23185.60, change: 45.30, changePercent: 0.20,
    open: 23150.45, high: 23220.90, low: 23100.15, close: 23140.30,
    volume: 0, timestamp: Date.now(),
  },
  {
    token: '99926074', symbol: 'MIDCPNIFTY', exchange: 'NSE',
    ltp: 12450.25, change: 78.90, changePercent: 0.64,
    open: 12390.40, high: 12480.60, low: 12350.20, close: 12371.35,
    volume: 0, timestamp: Date.now(),
  },
];

// --- Mock F&O Scanner Data (Full typed FnoScannerRow universe) ---

// A plausible flat NIFTY change% for this mock session — relativeStrength
// below is derived from it rather than hand-picked per row, so it stays
// internally consistent with each row's own changePercent.
const MOCK_NIFTY_CHANGE_PERCENT = 0.55;

const MOCK_FNO_SCANNER_ROWS_BASE: Omit<FnoScannerRow, 'relativeStrength'>[] = [
  {
    symbol: 'RELIANCE', exchange: 'NSE', price: 2945.80, changePercent: 1.82, volume: 8524000,
    futuresOi: 15240000, futuresChangeOi: 580000, futuresChangeOiPercent: 3.96,
    oiInterpretation: 'LONG_BUILDUP', pcr: 1.12, atmIv: 22.5, ceIv: 21.8, peIv: 23.2, ivSkew: -1.4,
    ivRank: 45, ivPercentile: 48, atmGamma: 0.0024, atmTheta: -1.85, atmVega: 4.2, atmSpreadPct: 1.1,
    direction: 'BULLISH', confidence: 78, score: 82, timestamp: Date.now(),
  },
  {
    symbol: 'HDFCBANK', exchange: 'NSE', price: 1682.50, changePercent: -0.65, volume: 12100000,
    futuresOi: 28400000, futuresChangeOi: -1200000, futuresChangeOiPercent: -4.05,
    oiInterpretation: 'LONG_UNWINDING', pcr: 0.85, atmIv: 18.3, ceIv: 18.9, peIv: 17.7, ivSkew: 1.2,
    ivRank: 32, ivPercentile: 35, atmGamma: 0.0031, atmTheta: -1.42, atmVega: 3.1, atmSpreadPct: 1.4,
    direction: 'BEARISH', confidence: 64, score: 58, timestamp: Date.now(),
  },
  {
    symbol: 'ICICIBANK', exchange: 'NSE', price: 1245.30, changePercent: 0.92, volume: 9800000,
    futuresOi: 22100000, futuresChangeOi: 890000, futuresChangeOiPercent: 4.19,
    oiInterpretation: 'SHORT_COVERING', pcr: 1.05, atmIv: 20.1, ceIv: 19.8, peIv: 20.4, ivSkew: -0.6,
    ivRank: 55, ivPercentile: 52, atmGamma: 0.0028, atmTheta: -1.65, atmVega: 3.6, atmSpreadPct: 1.6,
    direction: 'BULLISH', confidence: 70, score: 74, timestamp: Date.now(),
  },
  {
    symbol: 'INFY', exchange: 'NSE', price: 1542.15, changePercent: 2.15, volume: 6200000,
    futuresOi: 12800000, futuresChangeOi: 1450000, futuresChangeOiPercent: 12.77,
    oiInterpretation: 'LONG_BUILDUP', pcr: 1.35, atmIv: 24.8, ceIv: 24.1, peIv: 25.5, ivSkew: -1.4,
    ivRank: 72, ivPercentile: 75, atmGamma: 0.0026, atmTheta: -1.95, atmVega: 4.8, atmSpreadPct: 1.3,
    direction: 'BULLISH', confidence: 84, score: 87, timestamp: Date.now(),
  },
  {
    symbol: 'TCS', exchange: 'NSE', price: 3890.40, changePercent: 0.45, volume: 3200000,
    futuresOi: 8900000, futuresChangeOi: 120000, futuresChangeOiPercent: 1.37,
    oiInterpretation: 'NEUTRAL', pcr: 0.95, atmIv: 16.2, ceIv: 16.0, peIv: 16.4, ivSkew: -0.4,
    ivRank: 28, ivPercentile: 30, atmGamma: 0.0018, atmTheta: -2.40, atmVega: 5.5, atmSpreadPct: 1.0,
    direction: 'NEUTRAL', confidence: 55, score: 60, timestamp: Date.now(),
  },
  {
    symbol: 'SBIN', exchange: 'NSE', price: 825.60, changePercent: -1.25, volume: 18500000,
    futuresOi: 35200000, futuresChangeOi: 2800000, futuresChangeOiPercent: 8.64,
    oiInterpretation: 'SHORT_BUILDUP', pcr: 0.72, atmIv: 28.4, ceIv: 29.5, peIv: 27.3, ivSkew: 2.2,
    ivRank: 82, ivPercentile: 85, atmGamma: 0.0042, atmTheta: -1.10, atmVega: 2.4, atmSpreadPct: 3.2,
    direction: 'BEARISH', confidence: 79, score: 38, timestamp: Date.now(),
  },
  {
    symbol: 'TATASTEEL', exchange: 'NSE', price: 152.30, changePercent: 3.42, volume: 22000000,
    futuresOi: 18900000, futuresChangeOi: 3200000, futuresChangeOiPercent: 20.38,
    oiInterpretation: 'LONG_BUILDUP', pcr: 1.48, atmIv: 32.1, ceIv: 31.2, peIv: 33.0, ivSkew: -1.8,
    ivRank: 88, ivPercentile: 91, atmGamma: 0.0085, atmTheta: -0.45, atmVega: 1.2, atmSpreadPct: 2.8,
    direction: 'BULLISH', confidence: 88, score: 92, timestamp: Date.now(),
  },
  {
    symbol: 'AXISBANK', exchange: 'NSE', price: 1128.75, changePercent: 0.18, volume: 7400000,
    futuresOi: 19500000, futuresChangeOi: -450000, futuresChangeOiPercent: -2.26,
    oiInterpretation: 'LONG_UNWINDING', pcr: 0.91, atmIv: 19.7, ceIv: 19.4, peIv: 20.0, ivSkew: -0.6,
    ivRank: 41, ivPercentile: 43, atmGamma: 0.0029, atmTheta: -1.50, atmVega: 3.2, atmSpreadPct: 1.9,
    direction: 'NEUTRAL', confidence: 52, score: 56, timestamp: Date.now(),
  },
  {
    symbol: 'BHARTIARTL', exchange: 'NSE', price: 1715.40, changePercent: 1.64, volume: 5400000,
    futuresOi: 11200000, futuresChangeOi: 820000, futuresChangeOiPercent: 7.90,
    oiInterpretation: 'LONG_BUILDUP', pcr: 1.22, atmIv: 17.5, ceIv: 17.0, peIv: 18.0, ivSkew: -1.0,
    ivRank: 38, ivPercentile: 42, atmGamma: 0.0025, atmTheta: -1.70, atmVega: 3.8, atmSpreadPct: 1.5,
    direction: 'BULLISH', confidence: 76, score: 81, timestamp: Date.now(),
  },
  {
    symbol: 'LT', exchange: 'NSE', price: 3620.00, changePercent: 1.15, volume: 2800000,
    futuresOi: 7800000, futuresChangeOi: -340000, futuresChangeOiPercent: -4.18,
    oiInterpretation: 'SHORT_COVERING', pcr: 1.18, atmIv: 21.4, ceIv: 20.9, peIv: 21.9, ivSkew: -1.0,
    ivRank: 49, ivPercentile: 51, atmGamma: 0.0019, atmTheta: -2.85, atmVega: 6.1, atmSpreadPct: 2.1,
    direction: 'BULLISH', confidence: 72, score: 79, timestamp: Date.now(),
  },
  {
    symbol: 'MARUTI', exchange: 'NSE', price: 12640.00, changePercent: 2.30, volume: 1200000,
    futuresOi: 3400000, futuresChangeOi: 420000, futuresChangeOiPercent: 14.09,
    oiInterpretation: 'LONG_BUILDUP', pcr: 1.38, atmIv: 23.6, ceIv: 22.8, peIv: 24.4, ivSkew: -1.6,
    ivRank: 64, ivPercentile: 68, atmGamma: 0.0008, atmTheta: -6.50, atmVega: 14.2, atmSpreadPct: 2.4,
    direction: 'BULLISH', confidence: 82, score: 86, timestamp: Date.now(),
  },
  {
    symbol: 'KOTAKBANK', exchange: 'NSE', price: 1745.20, changePercent: -0.85, volume: 4100000,
    futuresOi: 14200000, futuresChangeOi: 980000, futuresChangeOiPercent: 7.41,
    oiInterpretation: 'SHORT_BUILDUP', pcr: 0.78, atmIv: 19.2, ceIv: 20.1, peIv: 18.3, ivSkew: 1.8,
    ivRank: 58, ivPercentile: 60, atmGamma: 0.0027, atmTheta: -1.60, atmVega: 3.4, atmSpreadPct: 1.8,
    direction: 'BEARISH', confidence: 71, score: 44, timestamp: Date.now(),
  },
  {
    symbol: 'BAJFINANCE', exchange: 'NSE', price: 7280.50, changePercent: 1.75, volume: 1900000,
    futuresOi: 6100000, futuresChangeOi: 510000, futuresChangeOiPercent: 9.12,
    oiInterpretation: 'LONG_BUILDUP', pcr: 1.25, atmIv: 25.1, ceIv: 24.3, peIv: 25.9, ivSkew: -1.6,
    ivRank: 67, ivPercentile: 70, atmGamma: 0.0012, atmTheta: -4.80, atmVega: 10.5, atmSpreadPct: 2.0,
    direction: 'BULLISH', confidence: 80, score: 84, timestamp: Date.now(),
  },
  {
    symbol: 'ITC', exchange: 'NSE', price: 488.60, changePercent: 0.32, volume: 11500000,
    futuresOi: 42000000, futuresChangeOi: 180000, futuresChangeOiPercent: 0.43,
    oiInterpretation: 'NEUTRAL', pcr: 1.02, atmIv: 14.8, ceIv: 14.6, peIv: 15.0, ivSkew: -0.4,
    ivRank: 22, ivPercentile: 24, atmGamma: 0.0055, atmTheta: -0.65, atmVega: 1.6, atmSpreadPct: 1.7,
    direction: 'NEUTRAL', confidence: 50, score: 57, timestamp: Date.now(),
  },
  {
    symbol: 'M&M', exchange: 'NSE', price: 2840.30, changePercent: 2.85, volume: 3900000,
    futuresOi: 8600000, futuresChangeOi: 1120000, futuresChangeOiPercent: 14.97,
    oiInterpretation: 'LONG_BUILDUP', pcr: 1.42, atmIv: 27.8, ceIv: 26.9, peIv: 28.7, ivSkew: -1.8,
    ivRank: 78, ivPercentile: 81, atmGamma: 0.0021, atmTheta: -2.60, atmVega: 5.8, atmSpreadPct: 2.6,
    direction: 'BULLISH', confidence: 86, score: 89, timestamp: Date.now(),
  },
  {
    symbol: 'SUNPHARMA', exchange: 'NSE', price: 1780.00, changePercent: 0.78, volume: 2600000,
    futuresOi: 7200000, futuresChangeOi: -210000, futuresChangeOiPercent: -2.83,
    oiInterpretation: 'SHORT_COVERING', pcr: 1.08, atmIv: 18.6, ceIv: 18.2, peIv: 19.0, ivSkew: -0.8,
    ivRank: 36, ivPercentile: 39, atmGamma: 0.0026, atmTheta: -1.75, atmVega: 3.9, atmSpreadPct: 2.3,
    direction: 'BULLISH', confidence: 68, score: 73, timestamp: Date.now(),
  },
];

export const MOCK_FNO_SCANNER_ROWS: FnoScannerRow[] = MOCK_FNO_SCANNER_ROWS_BASE.map((r) => ({
  ...r,
  relativeStrength: Math.round((r.changePercent - MOCK_NIFTY_CHANGE_PERCENT) * 100) / 100,
}));

export const MOCK_FNO_SCANNER = MOCK_FNO_SCANNER_ROWS.map((r) => ({
  symbol: r.symbol,
  price: r.price,
  change: r.changePercent,
  volume: r.volume,
  futOI: r.futuresOi,
  changeOI: r.futuresChangeOi,
  oiType: r.oiInterpretation,
  pcr: r.pcr,
  iv: r.atmIv,
  ivRank: r.ivRank ?? 50,
  maxPain: Math.round(r.price / 50) * 50,
  bias: r.direction,
  confidence: r.confidence,
  score: r.score,
}));

// --- Mock Market Bias ---

export const MOCK_NIFTY_BIAS: MarketBias = {
  symbol: 'NIFTY',
  direction: 'BULLISH',
  bullishProbability: 68,
  bearishProbability: 11,
  neutralProbability: 21,
  confidence: 78,
  regime: 'STRONG_BULL_TREND',
  reasoning: [
    'Price comfortably holding above 20 EMA & VWAP (24,620 > 24,545)',
    'Supertrend bullish on 15m and 1H candles with expanding momentum',
    'RSI at 62 — healthy bullish continuation zone without divergence',
    'Massive Put OI concentration at 24,500 acting as rock-solid floor',
    'Call unwinding seen at 24,600 & 24,700 strikes (bears capitulating)',
    'PCR at 1.12 — supportive of further upward drift',
    'Futures OI shows fresh long buildup (+3.96%) with rising volume',
    'India VIX at 13.8% — subdued volatility favorable for trend-following',
  ],
  inputs: {
    spotPrice: 24620.35,
    vwap: 24545.20,
    rsi: 62,
    supertrend: 'BULLISH',
    pcr: 1.12,
    iv: 14.2,
    futuresOI: 'LONG_BUILDUP',
    maxPain: 24600,
    expectedMove: 240,
    expectedRangeLow: 24420,
    expectedRangeHigh: 24860,
    support: 24500,
    resistance: 24800,
  },
  timestamp: Date.now(),
};

export const MOCK_BANKNIFTY_BIAS: MarketBias = {
  symbol: 'BANKNIFTY',
  direction: 'NEUTRAL',
  bullishProbability: 42,
  bearishProbability: 38,
  neutralProbability: 20,
  confidence: 65,
  regime: 'RANGE_BOUND',
  reasoning: [
    'Price consolidating in 51,100 — 51,500 intraday equilibrium band',
    'HDFC Bank profit-booking offset by ICICI Bank buying strength',
    'Heavy Call OI concentration at 51,500 creating immediate ceiling',
    'Strong Put OI base anchored at 51,000 providing downside defense',
    'PCR at 0.94 indicating balanced options writer positioning',
  ],
  inputs: {
    spotPrice: 51240.80,
    vwap: 51290.40,
    rsi: 49,
    supertrend: 'NEUTRAL',
    pcr: 0.94,
    iv: 16.8,
    futuresOI: 'SHORT_BUILDUP',
    maxPain: 51200,
    expectedMove: 480,
    expectedRangeLow: 50800,
    expectedRangeHigh: 51700,
    support: 51000,
    resistance: 51500,
  },
  timestamp: Date.now(),
};

// --- Mock Intelligence Score ---

export const MOCK_NIFTY_SCORE: IntelligenceScore = {
  symbol: 'NIFTY',
  score: 78,
  trend: 82,
  priceAction: 75,
  futuresOi: 70,
  optionsOi: 80,
  pcr: 72,
  iv: 65,
  oiShifts: 78,
  volume: 68,
  relativeStrength: 74,
  technicals: 80,
  regime: 76,
  reasoning: [
    'Strong uptrend with higher highs and higher lows structure',
    'Futures OI confirms aggressive long addition',
    'Options OI shows dominant put writing across near strikes',
    'PCR supportive of steady upward trajectory',
    'Declining IV provides smooth tailwinds for bulls',
  ],
  timestamp: Date.now(),
};

// --- Mock FII/DII (NSE daily cash activity — realistic Rs crore figures) ---

export const MOCK_FII_DII: FiiDiiActivity = {
  date: 'Sample Session',
  fii: { buyValue: 13857.58, sellValue: 16969.52, netValue: -3111.94 },
  dii: { buyValue: 19254.19, sellValue: 10324.07, netValue: 8930.12 },
  fetchedAt: Date.now(),
};

export const MOCK_FII_DII_HISTORY: FiiDiiActivity[] = Array.from({ length: 14 }, (_, i) => {
  // Deterministic seeded wobble, not Math.random(), so mock data doesn't
  // jump around on every render/poll while the backend is offline.
  const seed = Math.sin(i * 12.9898) * 43758.5453;
  const wobble = (seed - Math.floor(seed)) * 2 - 1; // -1..1
  const fiiNet = Math.round(-2500 + wobble * 4000);
  const diiNet = Math.round(2000 - wobble * 3500);
  return {
    date: `Session -${14 - i}`,
    fii: { buyValue: 12000 + Math.abs(fiiNet), sellValue: 12000 + Math.max(0, -fiiNet), netValue: fiiNet },
    dii: { buyValue: 11000 + Math.abs(diiNet), sellValue: 11000 + Math.max(0, -diiNet), netValue: diiNet },
    fetchedAt: Date.now() - (14 - i) * 24 * 60 * 60 * 1000,
  };
});

// --- Mock Institutional Flow Snapshot ---

export const MOCK_INSTITUTIONAL_SNAPSHOT: InstitutionalFlowSnapshot = {
  vix: { value: 13.82, changePercent: -2.3 },
  niftyPcr: 1.12,
  bankNiftyPcr: 1.05,
  indexFuturesLean: [
    { symbol: 'NIFTY', interpretation: 'LONG_BUILDUP', changeOiPercent: 3.96 },
    { symbol: 'BANKNIFTY', interpretation: 'SHORT_COVERING', changeOiPercent: 2.1 },
  ],
  stockFuturesBuildup: { longBuildup: 62, shortBuildup: 24, shortCovering: 38, longUnwinding: 18, neutral: 20, total: 162 },
  optionOiLean: { putHeavyPct: 46, callHeavyPct: 28, sampledSymbols: 140 },
  fiiDii: MOCK_FII_DII,
  sentimentScore: 71,
  sentimentLabel: 'BULLISH',
  confidenceScore: 68,
  institutionalConvictionScore: 62,
  sentimentReasoning: ['Sample sentiment composite — live broker connection unavailable.'],
  availableInputs: ['India VIX', 'NIFTY/BANKNIFTY PCR', 'FII/DII Cash Activity'],
  unavailableInputs: [],
  timestamp: Date.now(),
};

// --- Mock Option Chain Summary (NIFTY-scale figures) ---

export const MOCK_OPTION_CHAIN_SUMMARY: OptionChainSummary = {
  callOi: 84_500_000,
  putOi: 96_200_000,
  callOiChange: -1_250_000,
  putOiChange: 2_180_000,
  pcr: 1.12,
  maxPain: 24600,
  atmIv: 14.2,
  highestCallOiStrike: 24800,
  highestPutOiStrike: 24500,
};

// --- Data Source Label ---

export const MOCK_DATA_LABEL =
  '⚠️ MOCK DATA — this overview, the F&O scanner, and market bias/regime are sample data (not wired to a live signal engine yet). Use "+ Add Asset" for real Option Chain / Futures data.';

