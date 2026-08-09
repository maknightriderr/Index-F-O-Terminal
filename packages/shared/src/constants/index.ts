// ============================================================
// EXCHANGE CONSTANTS
// ============================================================
// Trading hours, holidays, segment codes, and exchange
// configuration for NSE, BSE, and MCX.
// ============================================================

import type { Exchange, ExchangeSegment, TradingHours } from '../types/index.js';

// --- Trading Hours ---

export const TRADING_HOURS: Record<Exchange, TradingHours> = {
  NSE: { open: '09:15', close: '15:30', timezone: 'Asia/Kolkata' },
  BSE: { open: '09:15', close: '15:30', timezone: 'Asia/Kolkata' },
  MCX: { open: '09:00', close: '23:30', timezone: 'Asia/Kolkata' },
};

// --- Exchange Segment Codes (Angel One WebSocket) ---

export const EXCHANGE_SEGMENT_CODES: Record<ExchangeSegment, number> = {
  NSE_CM: 1,
  NSE_FO: 2,
  BSE_CM: 3,
  BSE_FO: 4,
  MCX_FO: 5,
};

export const EXCHANGE_SEGMENT_MAP: Record<string, ExchangeSegment> = {
  nse_cm: 'NSE_CM',
  nse_fo: 'NSE_FO',
  bse_cm: 'BSE_CM',
  bse_fo: 'BSE_FO',
  mcx_fo: 'MCX_FO',
};

// --- Segment lookup by base exchange ---
// A quote/spot request needs the CM segment; an option/future contract
// needs the FO segment — both keyed off the same base Exchange. MCX has
// no separate cash-market segment in this domain, so both maps agree there.

export const CM_SEGMENT: Record<Exchange, ExchangeSegment> = {
  NSE: 'NSE_CM',
  BSE: 'BSE_CM',
  MCX: 'MCX_FO',
};

export const FO_SEGMENT: Record<Exchange, ExchangeSegment> = {
  NSE: 'NSE_FO',
  BSE: 'BSE_FO',
  MCX: 'MCX_FO',
};

// --- Angel One API segment strings ---

export const ANGEL_EXCHANGE_MAP: Record<string, Exchange> = {
  NSE: 'NSE',
  BSE: 'BSE',
  MCX: 'MCX',
};

export const ANGEL_SEGMENT_MAP: Record<string, ExchangeSegment> = {
  nse_cm: 'NSE_CM',
  nse_fo: 'NSE_FO',
  bse_cm: 'BSE_CM',
  bse_fo: 'BSE_FO',
  mcx_fo: 'MCX_FO',
};

// --- Well-known Index Tokens (Angel One) ---
// These are stable token IDs for major indices in the scrip master.
// Used as fallbacks; the scrip master is always the golden source.

export const KNOWN_INDEX_TOKENS: Record<string, string> = {
  NIFTY: '99926000',
  BANKNIFTY: '99926009',
  FINNIFTY: '99926037',
  MIDCPNIFTY: '99926074',
  SENSEX: '99919000',
  BANKEX: '99919067',
};

// --- Known Index Symbols ---

export const INDEX_SYMBOLS = [
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'SENSEX',
  'BANKEX',
  'NIFTY IT',
  'NIFTY BANK',
  'NIFTY FINANCIAL SERVICES',
  'NIFTY AUTO',
  'NIFTY PHARMA',
  'NIFTY METAL',
  'NIFTY ENERGY',
  'NIFTY FMCG',
  'NIFTY REALTY',
  'NIFTY MEDIA',
  'NIFTY PSE',
  'NIFTY INFRA',
] as const;

// --- Candle Interval Mapping ---

export const CANDLE_INTERVALS = {
  '1m': 'ONE_MINUTE',
  '3m': 'THREE_MINUTE',
  '5m': 'FIVE_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '30m': 'THIRTY_MINUTE',
  '1h': 'ONE_HOUR',
  '4h': 'FOUR_HOUR',
  '1d': 'ONE_DAY',
  '1w': 'ONE_WEEK',
  '1M': 'ONE_MONTH',
} as const;

// --- Sector Mapping ---

export const SECTOR_MAP: Record<string, string[]> = {
  Banking: ['HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK', 'BANKBARODA', 'PNB', 'INDUSINDBK', 'FEDERALBNK', 'IDFCFIRSTB', 'BANDHANBNK', 'AUBANK'],
  IT: ['TCS', 'INFY', 'WIPRO', 'HCLTECH', 'TECHM', 'LTIM', 'MPHASIS', 'COFORGE', 'PERSISTENT'],
  Auto: ['MARUTI', 'M&M', 'TATAMOTORS', 'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT', 'ASHOKLEY', 'TVSMOTOR', 'BALKRISIND'],
  Pharma: ['SUNPHARMA', 'DRREDDY', 'CIPLA', 'DIVISLAB', 'APOLLOHOSP', 'BIOCON', 'AUROPHARMA', 'LUPIN', 'TORNTPHARM'],
  Metal: ['TATASTEEL', 'HINDALCO', 'JSWSTEEL', 'VEDL', 'COALINDIA', 'NMDC', 'SAIL', 'NATIONALUM'],
  Energy: ['RELIANCE', 'ONGC', 'NTPC', 'POWERGRID', 'ADANIENT', 'ADANIGREEN', 'ADANIPORTS', 'GAIL', 'IOC', 'BPCL'],
  FMCG: ['HINDUNILVR', 'ITC', 'NESTLEIND', 'BRITANNIA', 'DABUR', 'MARICO', 'GODREJCP', 'COLPAL', 'TATACONSUM'],
  Realty: ['DLF', 'GODREJPROP', 'OBEROIRLTY', 'PRESTIGE', 'PHOENIXLTD', 'BRIGADE'],
  'Financial Services': ['BAJFINANCE', 'BAJAJFINSV', 'HDFCLIFE', 'SBILIFE', 'ICICIPRULI', 'MUTHOOTFIN', 'CHOLAFIN', 'SHRIRAMFIN', 'PFC', 'RECLTD'],
  Telecom: ['BHARTIARTL', 'IDEA'],
  Infrastructure: ['LT', 'ULTRACEMCO', 'GRASIM', 'ACC', 'AMBUJACEM', 'SIEMENS', 'ABB'],
};

// --- Option Chain Config ---

export const DEFAULT_STRIKE_RANGE = 20; // Number of strikes above and below ATM
export const OPTION_CHAIN_REFRESH_INTERVAL_MS = 3000;
export const GREEKS_REFRESH_INTERVAL_MS = 30000;

// --- WebSocket Config ---

export const WS_MAX_SUBSCRIPTIONS = 1000;
export const WS_HEARTBEAT_INTERVAL_MS = 30000;
export const WS_RECONNECT_BASE_DELAY_MS = 1000;
export const WS_RECONNECT_MAX_DELAY_MS = 30000;
export const WS_STALE_DATA_THRESHOLD_MS = 15000;

// --- Risk Engine Defaults ---

export const DEFAULT_RISK_CONFIG = {
  tradingCapital: 500000,
  maxRiskPerTrade: 2,        // 2%
  maxDailyLoss: 10000,
  maxPositions: 5,
  maxPortfolioDelta: 500,
  maxPortfolioGamma: 100,
};

// --- Risk-Free Rate (for Black-Scholes) ---

export const RISK_FREE_RATE = 0.07; // 7% — RBI repo rate approximation
