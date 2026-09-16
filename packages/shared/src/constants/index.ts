// ============================================================
// EXCHANGE CONSTANTS
// ============================================================
// Trading hours, holidays, segment codes, and exchange
// configuration for NSE, BSE, and MCX.
// ============================================================

import type { Exchange, ExchangeHoliday, ExchangeSegment, TradingHours } from '../types/index.js';

// --- Trading Hours ---

export const TRADING_HOURS: Record<Exchange, TradingHours> = {
  NSE: { open: '09:15', close: '15:30', timezone: 'Asia/Kolkata' },
  BSE: { open: '09:15', close: '15:30', timezone: 'Asia/Kolkata' },
  MCX: { open: '09:00', close: '23:30', timezone: 'Asia/Kolkata' },
};

/** MCX splits its day into a morning and an evening session here — partial holidays shut one side of this boundary. */
export const MCX_EVENING_SESSION_OPEN = '17:00';

/** MCX's evening session closes here instead of TRADING_HOURS.MCX.close while the US is on daylight saving time — see getSessionCloseTime. */
export const MCX_US_DST_CLOSE = '23:55';

/**
 * A new trade setup isn't minted in the first minutes of a session — the
 * opening quotes are still catching up from the pre-open auction (a 09:03
 * BANKNIFTY setup priced off pre-open quotes "won" +77% on the 09:15 gap).
 * Shared so Backtesting judges historical rows by the same rule.
 */
export const SETUP_OPENING_SETTLE_MINUTES = 5;

/**
 * Flat round-trip cost (% of entry premium) assumed for setups recorded
 * before each setup carried its own cost estimate — Backtesting's fallback.
 * New setups are gated and reported on estimateRoundTripCost (@fno/analytics)
 * built from TRADING_COST_MODEL below.
 */
export const ESTIMATED_ROUND_TRIP_COST_PCT = 3;

/**
 * Inputs to a long option's estimated round-trip cost. The flat 3% it
 * replaces ignored the actual quote: a liquid index option with a 0.05
 * spread and a thinly traded stock option were charged the same, and for
 * monthly stock options that alone was enough to refuse every setup.
 */
export const TRADING_COST_MODEL = {
  /** ₹ per executed order (typical discount-broker flat fee); two orders per round trip. */
  brokeragePerOrder: 20,
  /** GST on brokerage. */
  gstPct: 18,
  /** STT on the sell leg (~0.1%) + exchange transaction charges on both legs + stamp duty + GST on them, as % of entry premium. */
  statutoryPct: 0.2,
  /** Allowance beyond the quoted spread — a stop-loss exit is a market order in a moving book. */
  slippagePct: 1,
  /** Spread assumed when the leg has no two-sided quote, as % of premium. */
  fallbackSpreadPct: 2,
} as const;

/**
 * When trade-selection logic last changed materially (confidence per
 * source, hold bands, index futures volume, previous-close OI, IV pressure
 * off the forward, regime weighting, room-to-target cap — 16 Sep 2026
 * 20:49 IST; then per-trade cost estimates from the live quote replacing
 * the flat 3% gate — 16 Sep 2026 21:46 IST). Backtesting's "Current logic" view counts only
 * setups generated from here on, so results under the new logic aren't
 * pooled with the old. Move this forward whenever selection logic changes
 * enough that earlier results stop describing it.
 */
export const TRADE_LOGIC_UPDATED_AT = Date.parse('2026-09-16T21:46:00+05:30');

// --- Exchange Holidays ---
// Weekday closures only — weekends are already closed by isMarketOpen.
// Without this, a weekday holiday read as a normal session everywhere, and
// quote timestamps are fetch times rather than exchange times, so the
// quotes themselves can't reveal a holiday either.
//
// Needs each new year added once the exchanges publish their list (usually
// December). Not modelled: special weekend sessions — Budget Sunday
// (1 Feb 2026) and Muhurat trading (8 Nov 2026) stay closed here.
// BSE's equity/F&O list matches NSE's.

const NSE_HOLIDAYS: ExchangeHoliday[] = [
  { date: '2026-01-15', name: 'Municipal Corporation Elections', closed: 'FULL' },
  { date: '2026-01-26', name: 'Republic Day', closed: 'FULL' },
  { date: '2026-03-03', name: 'Holi', closed: 'FULL' },
  { date: '2026-03-26', name: 'Shri Ram Navami', closed: 'FULL' },
  { date: '2026-03-31', name: 'Shri Mahavir Jayanti', closed: 'FULL' },
  { date: '2026-04-03', name: 'Good Friday', closed: 'FULL' },
  { date: '2026-04-14', name: 'Dr. Baba Saheb Ambedkar Jayanti', closed: 'FULL' },
  { date: '2026-05-01', name: 'Maharashtra Day', closed: 'FULL' },
  { date: '2026-05-28', name: 'Bakri Id', closed: 'FULL' },
  { date: '2026-06-26', name: 'Muharram', closed: 'FULL' },
  { date: '2026-09-14', name: 'Ganesh Chaturthi', closed: 'FULL' },
  { date: '2026-10-02', name: 'Mahatma Gandhi Jayanti', closed: 'FULL' },
  { date: '2026-10-20', name: 'Dussehra', closed: 'FULL' },
  { date: '2026-11-10', name: 'Diwali Balipratipada', closed: 'FULL' },
  { date: '2026-11-24', name: 'Guru Nanak Jayanti', closed: 'FULL' },
  { date: '2026-12-25', name: 'Christmas', closed: 'FULL' },
];

const MCX_HOLIDAYS: ExchangeHoliday[] = [
  { date: '2026-01-01', name: "New Year's Day", closed: 'EVENING' },
  { date: '2026-01-15', name: 'Municipal Corporation Elections', closed: 'MORNING' },
  { date: '2026-01-26', name: 'Republic Day', closed: 'FULL' },
  { date: '2026-03-03', name: 'Holi', closed: 'MORNING' },
  { date: '2026-03-26', name: 'Shri Ram Navami', closed: 'MORNING' },
  { date: '2026-03-31', name: 'Shri Mahavir Jayanti', closed: 'MORNING' },
  { date: '2026-04-03', name: 'Good Friday', closed: 'FULL' },
  { date: '2026-04-14', name: 'Dr. Baba Saheb Ambedkar Jayanti', closed: 'MORNING' },
  { date: '2026-05-01', name: 'Maharashtra Day', closed: 'MORNING' },
  { date: '2026-05-28', name: 'Bakri Id', closed: 'MORNING' },
  { date: '2026-06-26', name: 'Muharram', closed: 'MORNING' },
  { date: '2026-09-14', name: 'Ganesh Chaturthi', closed: 'MORNING' },
  { date: '2026-10-02', name: 'Mahatma Gandhi Jayanti', closed: 'FULL' },
  { date: '2026-10-20', name: 'Dussehra', closed: 'MORNING' },
  { date: '2026-11-10', name: 'Diwali Balipratipada', closed: 'MORNING' },
  { date: '2026-11-24', name: 'Guru Nanak Jayanti', closed: 'MORNING' },
  { date: '2026-12-25', name: 'Christmas', closed: 'FULL' },
];

const byDate = (list: ExchangeHoliday[]): Record<string, ExchangeHoliday> => Object.fromEntries(list.map((h) => [h.date, h]));

/** Calendar years every exchange's holiday list covers. A year missing here means isMarketOpen treats that year's holidays as trading days. */
export const HOLIDAY_CALENDAR_YEARS: readonly number[] = (() => {
  const yearsOf = (list: ExchangeHoliday[]) => new Set(list.map((h) => Number(h.date.slice(0, 4))));
  const mcxYears = yearsOf(MCX_HOLIDAYS);
  return Array.from(yearsOf(NSE_HOLIDAYS))
    .filter((y) => mcxYears.has(y))
    .sort((a, b) => a - b);
})();

export const EXCHANGE_HOLIDAYS: Record<Exchange, Record<string, ExchangeHoliday>> = {
  NSE: byDate(NSE_HOLIDAYS),
  BSE: byDate(NSE_HOLIDAYS),
  MCX: byDate(MCX_HOLIDAYS),
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
  // NSE — broad market & sectoral
  NIFTY: '99926000',
  BANKNIFTY: '99926009',
  FINNIFTY: '99926037',
  MIDCPNIFTY: '99926074',
  NIFTYNEXT50: '99926013',
  NIFTY100: '99926012',
  NIFTY500: '99926004',
  INDIAVIX: '99926017',
  NIFTYIT: '99926008',
  NIFTYAUTO: '99926029',
  NIFTYPHARMA: '99926023',
  NIFTYFMCG: '99926021',
  NIFTYMETAL: '99926030',
  NIFTYREALTY: '99926018',
  NIFTYENERGY: '99926020',
  NIFTYPSUBANK: '99926025',
  NIFTYPVTBANK: '99926047',
  NIFTYMEDIA: '99926031',
  NIFTYINFRA: '99926019',
  // BSE — broad market & sectoral
  SENSEX: '99919000',
  BANKEX: '99919012',
  BSE100: '99919002',
  BSE200: '99919003',
  BSE500: '99919004',
  BSEMIDCAP: '99919016',
  BSESMALLCAP: '99919017',
  BSEIT: '99919005',
  // MCX — commodity benchmark indices. Angel One's instrument master lists
  // several more (MCXCOMDEX, MCXAGRI, MCXENERGY, MCXMETAL, and their "S-"
  // variants) but those tokens return an all-zero quote — confirmed
  // live, not just a guess — so they're stale/inactive tickers left out
  // of KNOWN_INDEX_TOKENS entirely rather than shown as broken rows.
  MCXBULLDEX: '99920005',
  MCXMETLDEX: '99920004',
  MCXCOMPDEX: '99920006',
  MCXCRUDEX: '99920000',
  MCXCOPRDEX: '99920001',
  MCXSILVDEX: '99920002',
  MCXGOLDEX: '99920003',
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

// ATM bid-ask spread as a % of mid, wider than this and an entry/SL/target
// can't be trusted to actually fill near the quoted price — the same gate
// Trade Setup uses for naked longs, the F&O Stocks "liquid only" filter,
// and the Market Scanner's stock-shortlist step.
export const LIQUID_SPREAD_MAX_PCT = 5;

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
  /**
   * Cap on the PREMIUM actually paid for a single naked long, as a % of
   * capital — a second, independent bound alongside maxRiskPerTrade.
   *
   * maxRiskPerTrade only bounds the loss if the stop FILLS. A long option's
   * true maximum loss is 100% of premium: it can gap through the stop
   * overnight, or collapse faster than an exit gets worked on expiry day.
   * Sizing on the stop alone means a TIGHTER stop buys MORE lots for the
   * same nominal risk — so tightening stops to fix reward:risk silently
   * doubled the capital deployed (and the real tail loss) per trade.
   * Measured: a 15% stop produced 13 lots / ₹65,000 outlay to risk a
   * nominal ₹9,750. This is the bound that stops that.
   *
   * 5% of capital = 2.5x maxRiskPerTrade, i.e. a total wipeout of one
   * position costs about two and a half planned stop-outs.
   */
  maxPremiumPerTradePct: 5,
};

// --- Risk-Free Rate (for Black-Scholes) ---

export const RISK_FREE_RATE = 0.07; // 7% — RBI repo rate approximation

// --- IV Rank Bands ---
// Single source of truth for "is this option's premium rich or cheap
// relative to its own recent range" — shared between the Strategy
// Scanner (which recommends selling premium above this) and the Trade
// Setup engine (which refuses to propose a naked long above this), so
// the two features can't independently drift into contradicting each
// other on the same symbol.
export const IV_RANK_HIGH_THRESHOLD = 60;
export const IV_RANK_LOW_THRESHOLD = 40;
