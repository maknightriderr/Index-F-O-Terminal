// ============================================================
// DATA PROVIDER INTERFACE
// ============================================================
// Abstract interface for market data providers. All business
// logic depends on this interface, not on any specific broker.
// New providers implement this interface.
// ============================================================

import type {
  Exchange,
  ExchangeSegment,
  Instrument,
  OHLCV,
  HistoricalParams,
  Tick,
  SubscriptionMode,
} from '@fno/shared';

// --- Authentication ---

export interface AuthCredentials {
  apiKey: string;
  clientId: string;
  password: string;
  totpSecret?: string;
}

export interface AuthResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  feedToken?: string;
  expiresAt?: number;
  error?: string;
}

// --- Greeks API Response ---

export interface ProviderGreeksData {
  name: string;
  expiry: string;
  strikePrice: number;
  optionType: string;
  ltp: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

// --- Market Status ---

export interface MarketStatus {
  exchange: Exchange;
  isOpen: boolean;
  nextOpen?: string;
  nextClose?: string;
  session?: string;
}

// --- Quote (richer than LTP — OI, bid/ask, OHLC) ---

export type QuoteMode = 'LTP' | 'OHLC' | 'FULL';

export interface QuoteDepthLevel {
  price: number;
  quantity: number;
  orders: number;
}

export interface ProviderQuote {
  token: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
  netChange?: number;
  percentChange?: number;
  avgPrice?: number;
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
  depth?: { buy: QuoteDepthLevel[]; sell: QuoteDepthLevel[] };
  timestamp: number;
}

// --- WebSocket Connection ---

export interface WebSocketConfig {
  url: string;
  authToken: string;
  apiKey: string;
  clientId: string;
  feedToken: string;
}

export type TickCallback = (ticks: Tick[]) => void;

export interface WebSocketConnection {
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(tokens: Array<{ token: string; exchangeSegment: ExchangeSegment; mode: SubscriptionMode }>): void;
  unsubscribe(tokens: Array<{ token: string; exchangeSegment: ExchangeSegment }>): void;
  onTick(callback: TickCallback): void;
  onError(callback: (error: Error) => void): void;
  onDisconnect(callback: (code: number, reason: string) => void): void;
  onReconnect(callback: () => void): void;
  isConnected(): boolean;
  getSubscriptionCount(): number;
}

// --- Main Provider Interface ---

export interface MarketDataProvider {
  /** Unique name for this provider */
  readonly name: string;

  /** Authenticate with the provider */
  authenticate(credentials: AuthCredentials): Promise<AuthResult>;

  /** Refresh authentication tokens */
  refreshAuth(): Promise<AuthResult>;

  /** Check if currently authenticated */
  isAuthenticated(): boolean;

  /** Logout / invalidate tokens */
  logout(): Promise<void>;

  /** Download and parse the instrument master list */
  getInstrumentMaster(): Promise<Instrument[]>;

  /** Search instruments by symbol, name, or trading symbol */
  searchInstruments(query: string, exchange?: Exchange, segment?: string): Promise<Instrument[]>;

  /** Get instrument details by token */
  getInstrumentByToken(token: string, exchange: Exchange): Promise<Instrument | null>;

  /** Get expiry dates for an underlying */
  getExpiries(underlying: string, exchange: Exchange): Promise<string[]>;

  /** Get historical OHLCV data */
  getHistoricalData(params: HistoricalParams): Promise<OHLCV[]>;

  /** Get option Greeks for an underlying + expiry */
  getOptionGreeks(name: string, expiry: string): Promise<ProviderGreeksData[]>;

  /** Get Last Traded Price for tokens */
  getLTP(exchange: Exchange, tokens: string[]): Promise<Array<{ token: string; ltp: number }>>;

  /** Get full quotes (OI, bid/ask, OHLC) for tokens. Chunked internally if needed. */
  getQuote(exchange: Exchange, tokens: string[], mode?: QuoteMode): Promise<ProviderQuote[]>;

  /** Get market status for an exchange */
  getMarketStatus(exchange: Exchange): Promise<MarketStatus>;

  /** Create a WebSocket connection for real-time data */
  createWebSocketConnection(config?: Partial<WebSocketConfig>): WebSocketConnection;
}
