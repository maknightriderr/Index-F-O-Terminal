// ============================================================
// MOCK DATA — For UI Development Only
// ============================================================
// This file provides mock data for developing UI components
// BEFORE live broker integration is active. All mock data is
// clearly isolated here. Replace with live data in Phase 2.
// ============================================================

import type {
  MarketQuote,
  OptionChain,
  OptionChainStrike,
  FuturesData,
  MarketBias,
  IntelligenceScore,
  SystemHealth,
} from '@fno/shared';

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

// --- Mock F&O Scanner Data ---

export const MOCK_FNO_SCANNER = [
  { symbol: 'RELIANCE', price: 2945.80, change: 1.82, volume: 8524000, futOI: 15240000, changeOI: 580000, oiType: 'LONG_BUILDUP' as const, pcr: 1.12, iv: 22.5, ivRank: 45, maxPain: 2950, bias: 'BULLISH' as const, confidence: 72, score: 78 },
  { symbol: 'HDFCBANK', price: 1682.50, change: -0.65, volume: 12100000, futOI: 28400000, changeOI: -1200000, oiType: 'LONG_UNWINDING' as const, pcr: 0.85, iv: 18.3, ivRank: 32, maxPain: 1700, bias: 'BEARISH' as const, confidence: 64, score: 62 },
  { symbol: 'ICICIBANK', price: 1245.30, change: 0.92, volume: 9800000, futOI: 22100000, changeOI: 890000, oiType: 'SHORT_COVERING' as const, pcr: 1.05, iv: 20.1, ivRank: 55, maxPain: 1250, bias: 'BULLISH' as const, confidence: 68, score: 71 },
  { symbol: 'INFY', price: 1542.15, change: 2.15, volume: 6200000, futOI: 12800000, changeOI: 1450000, oiType: 'LONG_BUILDUP' as const, pcr: 1.35, iv: 24.8, ivRank: 72, maxPain: 1540, bias: 'BULLISH' as const, confidence: 81, score: 85 },
  { symbol: 'TCS', price: 3890.40, change: 0.45, volume: 3200000, futOI: 8900000, changeOI: 120000, oiType: 'NEUTRAL' as const, pcr: 0.95, iv: 16.2, ivRank: 28, maxPain: 3900, bias: 'NEUTRAL' as const, confidence: 52, score: 55 },
  { symbol: 'SBIN', price: 825.60, change: -1.25, volume: 18500000, futOI: 35200000, changeOI: 2800000, oiType: 'SHORT_BUILDUP' as const, pcr: 0.72, iv: 28.4, ivRank: 82, maxPain: 830, bias: 'BEARISH' as const, confidence: 76, score: 74 },
  { symbol: 'TATASTEEL', price: 152.30, change: 3.42, volume: 22000000, futOI: 18900000, changeOI: 3200000, oiType: 'LONG_BUILDUP' as const, pcr: 1.48, iv: 32.1, ivRank: 88, maxPain: 150, bias: 'BULLISH' as const, confidence: 84, score: 88 },
  { symbol: 'AXISBANK', price: 1128.75, change: 0.18, volume: 7400000, futOI: 19500000, changeOI: -450000, oiType: 'LONG_UNWINDING' as const, pcr: 0.91, iv: 19.7, ivRank: 41, maxPain: 1130, bias: 'NEUTRAL' as const, confidence: 48, score: 52 },
];

// --- Mock Market Bias ---

export const MOCK_NIFTY_BIAS: MarketBias = {
  symbol: 'NIFTY',
  direction: 'BULLISH',
  bullishProbability: 68,
  bearishProbability: 11,
  neutralProbability: 21,
  confidence: 78,
  regime: 'WEAK_BULL_TREND',
  reasoning: [
    'Price above VWAP (24,620 > 24,545)',
    'Supertrend bullish on 15m and 1H',
    'RSI at 62 — bullish but not overbought',
    'Put OI concentration at 24,500 (strong support)',
    'Call OI build-up at 24,800 (resistance)',
    'PCR at 1.12 — moderately bullish',
    'Short covering observed in futures OI',
    'IV at 14.2% — below 30-day average (low fear)',
  ],
  inputs: {
    spotPrice: 24620.35,
    vwap: 24545.20,
    rsi: 62,
    supertrend: 'BULLISH',
    pcr: 1.12,
    iv: 14.2,
    futuresOI: 'SHORT_COVERING',
    maxPain: 24600,
    expectedMove: 240,
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
    'Strong uptrend with higher highs and higher lows',
    'Futures OI shows short covering pattern',
    'Options OI shows put writing dominance',
    'PCR supportive of bullish continuation',
    'IV declining — favorable for directional trades',
  ],
  timestamp: Date.now(),
};

// --- Data Source Label ---

export const MOCK_DATA_LABEL = '⚠️ MOCK DATA — Connect Angel One for live data';
