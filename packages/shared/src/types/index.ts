// ============================================================
// DOMAIN TYPES — Core entities for the F&O Terminal
// ============================================================
// These types are broker-agnostic. They represent the canonical
// domain model. Provider implementations map their data into
// these types.
// ============================================================

// --- Exchange & Segment ---

export type Exchange = 'NSE' | 'BSE' | 'MCX';

export type Segment = 'CM' | 'FO'; // Cash Market, Futures & Options

export type ExchangeSegment =
  | 'NSE_CM'
  | 'NSE_FO'
  | 'BSE_CM'
  | 'BSE_FO'
  | 'MCX_FO';

// --- Asset Types ---

export type AssetType = 'INDEX' | 'EQUITY';

export type InstrumentType =
  | 'EQ'        // Equity (cash)
  | 'INDEX'     // Index
  | 'FUTIDX'    // Index Future
  | 'FUTSTK'    // Stock Future
  | 'FUTCOM'    // Commodity Future (MCX)
  | 'OPTIDX'    // Index Option
  | 'OPTSTK'    // Stock Option
  | 'OPTFUT';   // Option on Future — commodity options (MCX)

export type OptionType = 'CE' | 'PE';

// --- Instrument ---

export interface Instrument {
  token: string;
  symbol: string;
  name: string;
  exchange: Exchange;
  segment: Segment;
  instrumentType: InstrumentType;
  underlying?: string;
  strike?: number;
  optionType?: OptionType;
  expiry?: string; // ISO date string
  lotSize: number;
  tickSize: number;
  isFnO: boolean;
}

// --- Asset (user-facing watchlist entity) ---

export interface Asset {
  id: string;
  symbol: string;
  name: string;
  assetType: AssetType;
  exchange: Exchange;
  token: string;
  underlying: string;
  lotSize: number;
  tickSize: number;
  strikeInterval?: number;
  hasFutures: boolean;
  hasOptions: boolean;
  tradingHours: TradingHours;
}

export interface TradingHours {
  open: string;   // "09:15"
  close: string;  // "15:30"
  timezone: string; // "Asia/Kolkata"
}

// --- Derivative Contracts ---

export interface FuturesContract {
  token: string;
  symbol: string;
  underlying: string;
  exchange: Exchange;
  expiry: string;
  lotSize: number;
  expiryLabel: 'current' | 'next' | 'far';
}

export interface OptionsContract {
  token: string;
  symbol: string;
  underlying: string;
  exchange: Exchange;
  strike: number;
  optionType: OptionType;
  expiry: string;
  lotSize: number;
}

export interface Expiry {
  date: string;       // ISO date
  label: string;      // "14 Aug 2025"
  type: 'weekly' | 'monthly';
  dte: number;        // Days to expiry
  isCurrentWeek: boolean;
  isCurrentMonth: boolean;
}

// --- Market Data ---

export interface Tick {
  token: string;
  exchange: Exchange;
  timestamp: number;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
  changeOi?: number;
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
  avgPrice?: number;
  totalBuyQty?: number;
  totalSellQty?: number;
}

export interface OHLCV {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketQuote {
  token: string;
  symbol: string;
  exchange: Exchange;
  ltp: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  close: number; // Previous close
  volume: number;
  vwap?: number;
  oi?: number;
  changeOi?: number;
  bid?: number;
  ask?: number;
  timestamp: number;
}

// --- Option Chain ---

export interface OptionChainStrike {
  strike: number;
  distanceFromSpot: number;
  call: OptionChainLeg | null;
  put: OptionChainLeg | null;
}

export interface OptionChainLeg {
  token: string;
  ltp: number;
  bid: number;
  ask: number;
  volume: number;
  oi: number;
  changeOi: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  oiInterpretation: OIInterpretation;
  /** ITM/ATM/OTM for THIS leg's own option type — calls and puts at the
   * same strike are never both ITM or both OTM, so this lives per-leg
   * rather than once per strike row. */
  moneyness: 'ITM' | 'ATM' | 'OTM';
  /** Greeks/IV source: broker-provided, or internally calculated when the broker had none. */
  greeksSource: 'BROKER' | 'CALCULATED';
  timestamp: number;
}

export interface OptionChain {
  symbol: string;
  underlying: string;
  exchange: Exchange;
  spotPrice: number;
  expiry: string;
  availableExpiries: string[];
  dte: number;
  strikeInterval: number;
  atmStrike: number;
  strikes: OptionChainStrike[];
  pcr: number;
  pcrDetail: { oiPCR: number; volumePCR: number; changeOiPCR: number; nearAtmPCR: number };
  maxPain: number;
  maxPainDistance: number;
  expectedMove: { points: number; upperBound: number; lowerBound: number };
  positionMomentum: PositionMomentum;
  oiTrap: OiTrapAnalysis;
  decay: DecayAnalysis;
  timestamp: number;
}

// --- Option Chain Intelligence (trapping / position momentum / decay / trade setup) ---

export type OiSideActivity = 'BUILDING' | 'REDUCING' | 'FLAT';

export interface PositionMomentum {
  callOi: number;
  putOi: number;
  callOiChange: number;
  putOiChange: number;
  callInterpretation: OIInterpretation;
  putInterpretation: OIInterpretation;
  callActivity: OiSideActivity;
  putActivity: OiSideActivity;
}

export interface OiTrapSide {
  active: boolean;
  strike: number | null;
  strength: number; // 0-100
}

export interface OiTrapAnalysis {
  call: OiTrapSide;
  put: OiTrapSide;
  summary: string;
}

export interface DecayAnalysis {
  atmCallThetaPct: number; // % of premium lost per day (negative)
  atmPutThetaPct: number;
  speed: 'SLOW' | 'MODERATE' | 'FAST' | 'EXTREME';
  dte: number;
}

export interface TradeSetup {
  available: boolean;
  side?: OptionType;
  strike?: number;
  entry?: number;
  stopLoss?: number;
  target?: number;
  riskReward?: number;
  reason: string;
  /** When this setup was locked in — stays fixed across polls until SL/target is hit, the day rolls over, or bias reverses. Absent when unavailable. */
  generatedAt?: number;
}

// --- Greeks ---

export interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  rho?: number;
}

export interface GreeksSnapshot extends Greeks {
  token: string;
  symbol: string;
  strike: number;
  optionType: OptionType;
  expiry: string;
  spotPrice: number;
  optionPrice: number;
  dte: number;
  timestamp: number;
}

// --- IV Intelligence ---

export interface IVData {
  symbol: string;
  currentIV: number;
  ivChange: number;
  ivRank: number;         // 0-100
  ivPercentile: number;   // 0-100
  historicalIV30: number;
  historicalIV60: number;
  historicalIV90: number;
  atmIV: number;
  ceIV: number;
  peIV: number;
  ivSkew: number;         // CE IV - PE IV
  timestamp: number;
}

// --- OI Intelligence ---

export type OIInterpretation =
  | 'LONG_BUILDUP'
  | 'SHORT_BUILDUP'
  | 'SHORT_COVERING'
  | 'LONG_UNWINDING'
  | 'CALL_WRITING'
  | 'PUT_WRITING'
  | 'CALL_UNWINDING'
  | 'PUT_UNWINDING'
  | 'NEUTRAL';

// --- F&O Stock Scanner ---

export interface FnoScannerRow {
  symbol: string;
  exchange: Exchange;
  price: number;
  changePercent: number;
  volume: number;
  futuresOi: number;
  futuresChangeOi: number;
  futuresChangeOiPercent: number;
  oiInterpretation: OIInterpretation;
  pcr: number;
  atmIv: number;
  ceIv: number;
  peIv: number;
  ivSkew: number;
  ivRank: number | null;
  ivPercentile: number | null;
  atmGamma: number;
  atmTheta: number;
  atmVega: number;
  direction: BiasDirection;
  confidence: number;
  score: number;
  /** Today's changePercent minus NIFTY's own changePercent — positive means this stock is outperforming the index today, not just moving with it. */
  relativeStrength: number;
  timestamp: number;
}

// --- Chart Pattern Detection ---

export type ChartPatternType =
  | 'DOUBLE_TOP'
  | 'DOUBLE_BOTTOM'
  | 'HEAD_AND_SHOULDERS'
  | 'INVERSE_HEAD_AND_SHOULDERS'
  | 'ASCENDING_TRIANGLE'
  | 'DESCENDING_TRIANGLE'
  | 'SYMMETRIC_TRIANGLE'
  | 'RISING_WEDGE'
  | 'FALLING_WEDGE'
  | 'BULLISH_FLAG'
  | 'BEARISH_FLAG';

export interface DetectedChartPattern {
  symbol: string;
  exchange: Exchange;
  interval: '15m' | '1h';
  pattern: ChartPatternType;
  direction: 'BULLISH' | 'BEARISH';
  confidence: number; // 0-100
  detectedAt: number;
  priceAtDetection: number;
}

export interface OIAnalysis {
  symbol: string;
  token: string;
  interpretation: OIInterpretation;
  priceChange: number;
  oiChange: number;
  volumeChange: number;
  confidence: number;      // 0-100
  timestamp: number;
}

export interface OIWall {
  type: 'SUPPORT' | 'RESISTANCE';
  strike: number;
  oi: number;
  changeOi: number;
  volume: number;
  iv: number;
  strength: number;       // 0-100
}

export interface OIShift {
  type: 'SUPPORT_SHIFT' | 'RESISTANCE_SHIFT';
  fromStrike: number;
  toStrike: number;
  direction: 'UP' | 'DOWN';
  magnitude: number;
  timestamp: number;
}

// --- PCR ---

export interface PCRData {
  symbol: string;
  oiPCR: number;
  volumePCR: number;
  changeOiPCR: number;
  nearAtmPCR: number;
  interpretation: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  timestamp: number;
}

// --- Max Pain ---

export interface MaxPainData {
  symbol: string;
  expiry: string;
  maxPain: number;
  previousMaxPain?: number;
  movement?: number;
  distanceFromSpot: number;
  spotPrice: number;
  timestamp: number;
}

// --- Expected Move ---

export interface ExpectedMove {
  symbol: string;
  spotPrice: number;
  iv: number;
  dte: number;
  expectedMove: number;
  upperBound: number;
  lowerBound: number;
  timestamp: number;
}

// --- Futures ---

export interface FuturesData {
  token: string;
  symbol: string;
  expiryLabel: 'current' | 'next' | 'far';
  spotPrice: number;
  futuresPrice: number;
  basis: number;
  premiumDiscount: number;  // percentage
  premiumDiscountType: 'PREMIUM' | 'DISCOUNT';
  volume: number;
  oi: number;
  changeOi: number;
  interpretation: OIInterpretation;
  expiry: string;
  dte: number;
  timestamp: number;
}

export interface FuturesChainResponse {
  underlying: string;
  exchange: Exchange;
  spotPrice: number;
  contracts: FuturesData[];
  timestamp: number;
}

// --- Market Regime ---

export type MarketRegime =
  | 'STRONG_BULL_TREND'
  | 'WEAK_BULL_TREND'
  | 'STRONG_BEAR_TREND'
  | 'WEAK_BEAR_TREND'
  | 'RANGE_BOUND'
  | 'HIGH_VOLATILITY'
  | 'LOW_VOLATILITY'
  | 'BREAKOUT'
  | 'BREAKDOWN'
  | 'EXPIRY_GAMMA';

// --- Market Bias ---

export type BiasDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface MarketBias {
  symbol: string;
  direction: BiasDirection;
  bullishProbability: number;
  bearishProbability: number;
  neutralProbability: number;
  confidence: number;       // 0-100
  regime: MarketRegime;
  reasoning: string[];
  inputs: Record<string, unknown>;
  timestamp: number;
}

// --- Intelligence Score ---

export interface IntelligenceScore {
  symbol: string;
  score: number;            // 0-100
  trend: number;
  priceAction: number;
  futuresOi: number;
  optionsOi: number;
  pcr: number;
  iv: number;
  oiShifts: number;
  volume: number;
  relativeStrength: number;
  technicals: number;
  regime: number;
  reasoning: string[];
  timestamp: number;
}

// --- Signals ---

export type SignalType =
  | 'MARKET_BIAS'
  | 'OI_SPIKE'
  | 'OI_UNWINDING'
  | 'CALL_WRITING'
  | 'PUT_WRITING'
  | 'SHORT_COVERING'
  | 'LONG_UNWINDING'
  | 'IV_SPIKE'
  | 'IV_CRUSH'
  | 'THETA_ACCELERATION'
  | 'GAMMA_SPIKE'
  | 'PCR_REVERSAL'
  | 'SUPPORT_BREAK'
  | 'RESISTANCE_BREAK'
  | 'OI_WALL_BREAK'
  | 'PRICE_OI_DIVERGENCE'
  | 'UNUSUAL_VOLUME'
  | 'UNUSUAL_ACTIVITY'
  | 'FUTURES_OI_SPIKE'
  | 'FUTURES_OI_REVERSAL'
  | 'TRADE_SETUP_CLOSED'
  | 'VIX_SPIKE'
  | 'PCR_EXTREME'
  | 'INSTITUTIONAL_ACTIVITY'
  | 'NEXT_DAY_BIAS';

export interface Signal {
  id: string;
  symbol: string;
  type: SignalType;
  direction: BiasDirection;
  confidence: number;       // 0-100
  bullishProb: number;
  bearishProb: number;
  neutralProb: number;
  inputs: Record<string, number>;
  reasoning: string;
  regime: MarketRegime;
  intelligenceScore: number;
  timestamp: number;
}

// --- Strategy ---

export type StrategyName =
  | 'LONG_CE'
  | 'LONG_PE'
  | 'BULL_CALL_SPREAD'
  | 'BULL_PUT_SPREAD'
  | 'CALL_RATIO_SPREAD'
  | 'BEAR_PUT_SPREAD'
  | 'BEAR_CALL_SPREAD'
  | 'PUT_RATIO_SPREAD'
  | 'IRON_CONDOR'
  | 'SHORT_STRANGLE'
  | 'SHORT_STRADDLE'
  | 'BUTTERFLY'
  | 'LONG_STRADDLE'
  | 'LONG_STRANGLE'
  | 'CALENDAR_SPREAD';

export type StrategyCategory =
  | 'DIRECTIONAL'
  | 'BULLISH'
  | 'BEARISH'
  | 'NEUTRAL'
  | 'VOLATILITY';

export interface StrategyLeg {
  strike: number;
  optionType: OptionType;
  action: 'BUY' | 'SELL';
  quantity: number;
  premium: number;
  iv: number;
  greeks: Greeks;
}

export interface StrategyRecommendation {
  name: StrategyName;
  category: StrategyCategory;
  score: number;            // 0-100
  legs: StrategyLeg[];
  entry: number;
  target: number;
  stopLoss: number;
  maxProfit: number;
  maxLoss: number;
  breakeven: number[];
  riskReward: number;
  marginRequired?: number;
  netDelta: number;
  netGamma: number;
  netTheta: number;
  netVega: number;
  probability: number;     // estimated win probability
  reasoning: string[];
  invalidation: string;
  assumptions: string[];
  dataTimestamp: number;
}

// --- Position ---

export interface Position {
  id: string;
  symbol: string;
  strike: number;
  optionType: OptionType;
  expiry: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  ltp: number;
  pnl: number;
  pnlPercent: number;
  greeks: Greeks;
  marginUsed?: number;
  timestamp: number;
}

export interface PortfolioGreeks {
  netDelta: number;
  netGamma: number;
  netTheta: number;
  netVega: number;
  totalPnl: number;
  totalMargin: number;
}

// --- Alerts ---

export type AlertChannel = 'TERMINAL' | 'BROWSER' | 'EMAIL' | 'TELEGRAM';

export interface Alert {
  id: string;
  symbol: string;
  type: SignalType;
  message: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  channels: AlertChannel[];
  triggered: boolean;
  triggeredAt?: number;
  createdAt: number;
  data?: Record<string, unknown>;
}

// --- Risk ---

export interface RiskConfig {
  tradingCapital: number;
  maxRiskPerTrade: number;       // percentage
  maxDailyLoss: number;          // absolute
  maxPositions: number;
  maxPortfolioDelta: number;
  maxPortfolioGamma: number;
}

export interface RiskCalculation {
  positionSize: number;
  lots: number;
  maxLoss: number;
  riskReward: number;
  suggestedQuantity: number;
  capitalAtRisk: number;         // percentage of trading capital
}

// --- Watchlist ---

export interface Watchlist {
  id: string;
  name: string;
  items: WatchlistItem[];
  sortOrder: number;
  createdAt: string;
}

export interface WatchlistItem {
  id: string;
  symbol: string;
  exchange: Exchange;
  sortOrder: number;
  quote?: MarketQuote;
  bias?: BiasDirection;
  confidence?: number;
  intelligenceScore?: number;
  futuresOi?: number;
  changeOi?: number;
  pcr?: number;
  iv?: number;
}

// --- System Health ---

export type ServiceStatus = 'HEALTHY' | 'DEGRADED' | 'DOWN';

export interface SystemHealth {
  websocket: {
    status: ServiceStatus;
    connected: boolean;
    lastTick?: number;
    latencyMs?: number;
    reconnectCount: number;
    errorCount: number;
    subscriptionCount: number;
    queueSize: number;
  };
  api: {
    status: ServiceStatus;
    responseTimeMs: number;
    errorRate: number;
  };
  database: {
    status: ServiceStatus;
    connectionPoolSize: number;
    activeConnections: number;
  };
  redis: {
    status: ServiceStatus;
    memoryUsed: string;
    hitRate: number;
  };
  dataFreshness: {
    status: 'LIVE' | 'STALE' | 'DISCONNECTED';
    lastUpdate: number;
    missingDataPercent: number;
  };
  workers: {
    analytics: ServiceStatus;
    strategy: ServiceStatus;
    alert: ServiceStatus;
  };
}

// --- Market Calendar ---

export interface MarketCalendar {
  exchange: Exchange;
  date: string;
  isTrading: boolean;
  isHoliday: boolean;
  holidayName?: string;
  isExpiry: boolean;
  expiryType?: 'weekly' | 'monthly';
  openTime: string;
  closeTime: string;
  specialSession?: string;
}

// --- Data Quality ---

export type DataSource = 'LIVE' | 'CACHED' | 'HISTORICAL' | 'CALCULATED' | 'MOCK';

export interface DataQuality {
  timestamp: number;
  source: DataSource;
  freshness: 'FRESH' | 'AGING' | 'STALE';
  freshnessMs: number;
  isValid: boolean;
  issues?: string[];
}

// --- API Response Envelope ---

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: {
    timestamp: number;
    source: DataSource;
    freshness: DataQuality;
  };
}

// --- Historical Data Params ---

export type CandleInterval =
  | 'ONE_MINUTE'
  | 'THREE_MINUTE'
  | 'FIVE_MINUTE'
  | 'FIFTEEN_MINUTE'
  | 'THIRTY_MINUTE'
  | 'ONE_HOUR'
  | 'FOUR_HOUR'
  | 'ONE_DAY'
  | 'ONE_WEEK'
  | 'ONE_MONTH';

export interface HistoricalParams {
  exchange: Exchange;
  token: string;
  interval: CandleInterval;
  fromDate: string;
  toDate: string;
}

// --- Institutional Flow ---
// FII/DII cash flows, participant-wise OI, and FII futures positions come
// from NSE's own end-of-day reports, not the Angel One API this app is
// built on — and USDINR/DXY/S&P500/Nasdaq/Dow/GIFT Nifty/Asian markets are
// outside Angel One's India-only coverage entirely. Every type below is
// deliberately built only from what's genuinely live (India VIX, PCR,
// aggregate index/stock futures OI, option OI activity, the existing
// market-bias engine) — `availableInputs`/`unavailableInputs` disclose
// exactly which real inputs a given read is/isn't based on, rather than
// presenting a number as complete when it isn't.

export type SentimentLabel = 'EXTREMELY_BEARISH' | 'BEARISH' | 'NEUTRAL' | 'BULLISH' | 'EXTREMELY_BULLISH';

export interface InstitutionalFlowSnapshot {
  vix: { value: number; changePercent: number } | null;
  niftyPcr: number | null;
  bankNiftyPcr: number | null;
  indexFuturesLean: Array<{ symbol: string; interpretation: OIInterpretation; changeOiPercent: number }>;
  stockFuturesBuildup: {
    longBuildup: number;
    shortBuildup: number;
    shortCovering: number;
    longUnwinding: number;
    neutral: number;
    total: number;
  };
  // Put/call OI skew across the F&O universe, not confirmed fresh writing
  // activity specifically (that would need per-stock intraday OI deltas by
  // leg, which the universe scanner doesn't track) — a real but weaker
  // signal than Section 2's example implies, named accordingly.
  optionOiLean: { putHeavyPct: number; callHeavyPct: number; sampledSymbols: number } | null;
  sentimentScore: number; // 0-100
  sentimentLabel: SentimentLabel;
  // How much the available inputs agree with each other (0-100) — distinct
  // from institutionalConvictionScore, which needs FII/DII/participant data
  // this app doesn't have and is reported null rather than approximated.
  confidenceScore: number;
  institutionalConvictionScore: number | null;
  sentimentReasoning: string[];
  availableInputs: string[];
  unavailableInputs: string[];
  timestamp: number;
}

export interface NextDayBias {
  symbol: string;
  gapUpProbability: number;
  gapDownProbability: number;
  trendDayProbability: number;
  rangeBoundProbability: number;
  volatileSessionProbability: number;
  expectedRangeLow: number;
  expectedRangeHigh: number;
  predictedDirection: BiasDirection;
  confidence: number;
  reasoning: string[];
  timestamp: number;
}

export interface InstitutionalCommentary {
  oneLineSummary: string;
  detailedAnalysis: string;
  bullCase: string;
  bearCase: string;
  riskFactors: string[];
  generatedAt: number;
}

export interface InstitutionalFlowPrediction {
  id: string;
  symbol: string;
  predictionDate: string; // IST date this prediction targets (the next trading session)
  createdAt: number;
  predictedDirection: BiasDirection;
  gapUpProbability: number;
  gapDownProbability: number;
  trendDayProbability: number;
  rangeBoundProbability: number;
  volatileSessionProbability: number;
  predictedRangeLow: number;
  predictedRangeHigh: number;
  predictionDayClose: number;
  resolved: boolean;
  actualOpen: number | null;
  actualHigh: number | null;
  actualLow: number | null;
  actualClose: number | null;
  actualGapType: 'GAP_UP' | 'GAP_DOWN' | 'FLAT' | null;
  actualDirection: BiasDirection | null;
  directionCorrect: boolean | null;
  rangeAccurate: boolean | null;
  forwardReturnPercent: number | null;
}

export interface PredictionAccuracyWindow {
  count: number;
  resolvedCount: number;
  directionAccuracyPercent: number | null;
  rangeAccuracyPercent: number | null;
  avgForwardReturnPercent: number | null;
}

export interface PredictionAccuracyStats {
  symbol: string;
  last7: PredictionAccuracyWindow;
  last30: PredictionAccuracyWindow;
  last100: PredictionAccuracyWindow;
  allTime: PredictionAccuracyWindow;
}

// --- Backtesting (Trade Setup outcome tracking) ---
// Every trade setup the market-bias engine actually generates (for
// whichever symbols get viewed/scanned — this can only track what the
// system genuinely produced, not backfill history) is persisted and its
// outcome recorded once resolved: WIN (target hit), LOSS (stop-loss hit),
// or EXPIRED (day rolled over or the bias reversed before either was
// hit — inconclusive, not a loss). `outcome: null` means still open.

export type TradeSetupOutcome = 'WIN' | 'LOSS' | 'EXPIRED';

export interface TradeSetupRecord {
  id: string;
  symbol: string;
  exchange: Exchange;
  generatedAt: number;
  direction: BiasDirection;
  confidence: number;
  side: OptionType;
  strike: number;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  reason: string;
  regime: MarketRegime | null;
  intelligenceScore: number | null;
  outcome: TradeSetupOutcome | null;
  exitPrice: number | null;
  exitTime: number | null;
  returnPercent: number | null;
}

export interface WinRateBucket {
  period: string; // 'YYYY-MM-DD' | 'YYYY-Www' | 'YYYY-MM' | 'YYYY'
  total: number;
  wins: number;
  losses: number;
  expired: number;
  open: number;
  winRatePercent: number | null; // wins / (wins + losses) — expired/open excluded from the denominator
  avgReturnPercent: number | null;
}

export interface SymbolWinRate extends WinRateBucket {
  symbol: string;
}

export interface WinRateAnalytics {
  overall: WinRateBucket;
  daily: WinRateBucket[];
  weekly: WinRateBucket[];
  monthly: WinRateBucket[];
  yearly: WinRateBucket[];
  bySymbol: SymbolWinRate[];
}

// --- WebSocket Subscription ---

export type SubscriptionMode = 'LTP' | 'QUOTE' | 'SNAP_QUOTE' | 'DEPTH';

export interface Subscription {
  token: string;
  exchange: Exchange;
  exchangeSegment: ExchangeSegment;
  mode: SubscriptionMode;
  source: string;         // e.g. "watchlist", "option-chain", "scanner"
}
