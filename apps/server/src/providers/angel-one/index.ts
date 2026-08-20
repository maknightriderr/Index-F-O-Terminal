// ============================================================
// ANGEL ONE SMARTAPI PROVIDER
// ============================================================
// Implements MarketDataProvider for Angel One SmartAPI.
// Handles: Auth (TOTP), Scrip Master, Historical Data,
// Greeks API, WebSocket v2 (binary protocol).
// ============================================================

import axios, { type AxiosInstance } from 'axios';
import { authenticator } from 'otplib';
import { logger } from '../../lib/logger.js';
import type {
  Exchange,
  ExchangeSegment,
  Instrument,
  InstrumentType,
  OHLCV,
  OptionType,
  HistoricalParams,
  Tick,
  SubscriptionMode,
} from '@fno/shared';
import { isExpiryActive } from '@fno/shared';
import type {
  MarketDataProvider,
  AuthCredentials,
  AuthResult,
  ProviderGreeksData,
  MarketStatus,
  WebSocketConnection,
  WebSocketConfig,
  TickCallback,
  ProviderQuote,
  QuoteMode,
} from '../interface.js';

// --- Constants ---

const BASE_URL = 'https://apiconnect.angelone.in';
const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';

const EXCHANGE_MAP: Record<string, Exchange> = {
  NSE: 'NSE',
  BSE: 'BSE',
  MCX: 'MCX',
};

const SEGMENT_TYPE_MAP: Record<string, ExchangeSegment> = {
  nse_cm: 'NSE_CM',
  nse_fo: 'NSE_FO',
  bse_cm: 'BSE_CM',
  bse_fo: 'BSE_FO',
  mcx_fo: 'MCX_FO',
};

const WS_EXCHANGE_CODES: Record<ExchangeSegment, number> = {
  NSE_CM: 1,
  NSE_FO: 2,
  BSE_CM: 3,
  BSE_FO: 4,
  MCX_FO: 5,
};

const WS_MODE_CODES: Record<SubscriptionMode, number> = {
  LTP: 1,
  QUOTE: 2,
  SNAP_QUOTE: 3,
  DEPTH: 4,
};

// The REST quote API keys `exchangeTokens` by these exchange strings — NOT
// the same as our plain Exchange type. A derivative token queried under
// "NSE" (cash market) instead of "NFO" simply returns no data.
const QUOTE_EXCHANGE_MAP: Record<ExchangeSegment, string> = {
  NSE_CM: 'NSE',
  NSE_FO: 'NFO',
  BSE_CM: 'BSE',
  BSE_FO: 'BFO',
  MCX_FO: 'MCX',
};

// --- Angel One Raw Instrument Shape ---

interface AngelInstrument {
  token: string;
  symbol: string;
  name: string;
  expiry: string;
  strike: string;
  lotsize: string;
  instrumenttype: string;
  exch_seg: string;
  tick_size: string;
}

// --- Provider Implementation ---

export class AngelOneProvider implements MarketDataProvider {
  readonly name = 'AngelOne';

  private api: AxiosInstance;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private feedToken: string | null = null;
  private credentials: AuthCredentials | null = null;
  private tokenExpiry: number = 0;
  private instrumentCache: Instrument[] = [];
  private instrumentCacheTime: number = 0;

  constructor() {
    this.api = axios.create({
      baseURL: BASE_URL,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // --- Authentication ---

  async authenticate(credentials: AuthCredentials): Promise<AuthResult> {
    this.credentials = credentials;

    try {
      // Generate TOTP
      const totp = credentials.totpSecret
        ? authenticator.generate(credentials.totpSecret)
        : '';

      const response = await this.api.post(
        '/rest/auth/angelbroking/user/v1/loginByPassword',
        {
          clientcode: credentials.clientId,
          password: credentials.password,
          totp: totp,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-UserType': 'USER',
            'X-SourceID': 'WEB',
            'X-ClientLocalIP': '',
            'X-ClientPublicIP': '',
            'X-MACAddress': '',
            'X-PrivateKey': credentials.apiKey,
          },
        }
      );

      if (response.data?.status && response.data?.data?.jwtToken) {
        this.accessToken = response.data.data.jwtToken;
        this.refreshToken = response.data.data.refreshToken;
        this.feedToken = response.data.data.feedToken;
        this.tokenExpiry = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

        logger.info('Angel One authentication successful');

        return {
          success: true,
          accessToken: this.accessToken!,
          refreshToken: this.refreshToken!,
          feedToken: this.feedToken!,
          expiresAt: this.tokenExpiry,
        };
      }

      const errorMsg = response.data?.message || 'Authentication failed';
      logger.error({ error: errorMsg }, 'Angel One authentication failed');
      return { success: false, error: errorMsg };
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || 'Authentication failed';
      logger.error({ error: errorMsg }, 'Angel One authentication error');
      return { success: false, error: errorMsg };
    }
  }

  async refreshAuth(): Promise<AuthResult> {
    if (!this.refreshToken || !this.credentials) {
      return { success: false, error: 'No refresh token or credentials available' };
    }

    try {
      const response = await this.api.post(
        '/rest/auth/angelbroking/jwt/v1/generateTokens',
        { refreshToken: this.refreshToken },
        { headers: this.getAuthHeaders() }
      );

      if (response.data?.status && response.data?.data?.jwtToken) {
        this.accessToken = response.data.data.jwtToken;
        this.refreshToken = response.data.data.refreshToken;
        this.feedToken = response.data.data.feedToken;
        this.tokenExpiry = Date.now() + 24 * 60 * 60 * 1000;

        logger.info('Angel One token refreshed');
        return {
          success: true,
          accessToken: this.accessToken!,
          refreshToken: this.refreshToken!,
          feedToken: this.feedToken!,
          expiresAt: this.tokenExpiry,
        };
      }

      // Angel One responded (no thrown error) but without a usable token —
      // e.g. the refresh token itself has expired. This used to return
      // here silently: no log line, and no fallback, which left the
      // provider stuck unauthenticated until the process restarted (the
      // scheduled refresh in index.ts only retries `if isAuthenticated()`,
      // so a token that's already expired never gets another attempt).
      // Fall back to a fresh TOTP login exactly like the catch block does.
      logger.warn({ error: response.data?.message }, 'Angel One token refresh returned no token — falling back to full re-authentication');
      return this.authenticate(this.credentials);
    } catch (error: any) {
      logger.error({ error: error.message }, 'Angel One token refresh failed');
      // Try full re-authentication
      return this.authenticate(this.credentials);
    }
  }

  isAuthenticated(): boolean {
    return !!this.accessToken && Date.now() < this.tokenExpiry;
  }

  async logout(): Promise<void> {
    if (!this.accessToken) return;

    try {
      await this.api.post(
        '/rest/secure/angelbroking/user/v1/logout',
        { clientcode: this.credentials?.clientId },
        { headers: this.getAuthHeaders() }
      );
    } catch {
      // Best-effort logout
    }

    this.accessToken = null;
    this.refreshToken = null;
    this.feedToken = null;
    this.tokenExpiry = 0;
    logger.info('Angel One logged out');
  }

  // --- Instrument Master ---

  async getInstrumentMaster(): Promise<Instrument[]> {
    // Cache for 24 hours (refreshed daily)
    const cacheAge = Date.now() - this.instrumentCacheTime;
    if (this.instrumentCache.length > 0 && cacheAge < 24 * 60 * 60 * 1000) {
      return this.instrumentCache;
    }

    try {
      logger.info('Downloading Angel One scrip master...');
      const response = await axios.get(SCRIP_MASTER_URL, { timeout: 60000 });
      const rawInstruments: AngelInstrument[] = response.data;

      logger.info({ count: rawInstruments.length }, 'Scrip master downloaded');

      this.instrumentCache = rawInstruments.map(raw => this.mapInstrument(raw));
      this.instrumentCacheTime = Date.now();

      return this.instrumentCache;
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to download scrip master');
      throw new Error(`Failed to download scrip master: ${error.message}`);
    }
  }

  async searchInstruments(
    query: string,
    exchange?: Exchange,
    segment?: string
  ): Promise<Instrument[]> {
    const instruments = await this.getInstrumentMaster();
    const queryUpper = query.toUpperCase().trim();

    return instruments.filter(inst => {
      if (exchange && inst.exchange !== exchange) return false;
      if (segment && inst.segment !== segment) return false;

      return (
        inst.symbol.toUpperCase().includes(queryUpper) ||
        inst.name.toUpperCase().includes(queryUpper) ||
        inst.token === queryUpper
      );
    }).slice(0, 50); // Limit results
  }

  async getInstrumentByToken(token: string, exchange: Exchange): Promise<Instrument | null> {
    const instruments = await this.getInstrumentMaster();
    return instruments.find(i => i.token === token && i.exchange === exchange) || null;
  }

  async getExpiries(underlying: string, exchange: Exchange): Promise<string[]> {
    const instruments = await this.getInstrumentMaster();
    const expiries = new Set<string>();

    instruments
      .filter(i =>
        i.underlying === underlying &&
        i.exchange === exchange &&
        isExpiryActive(i.expiry) &&
        (i.instrumentType === 'OPTIDX' || i.instrumentType === 'OPTSTK' || i.instrumentType === 'OPTFUT' ||
         i.instrumentType === 'FUTIDX' || i.instrumentType === 'FUTSTK' || i.instrumentType === 'FUTCOM')
      )
      .forEach(i => {
        if (i.expiry) expiries.add(i.expiry);
      });

    return Array.from(expiries).sort();
  }

  // --- Historical Data ---

  async getHistoricalData(params: HistoricalParams): Promise<OHLCV[]> {
    await this.ensureAuthenticated();

    try {
      const response = await this.api.post(
        '/rest/secure/angelbroking/historical/v1/getCandleData',
        {
          exchange: params.exchange,
          symboltoken: params.token,
          interval: params.interval,
          fromdate: params.fromDate,
          todate: params.toDate,
        },
        { headers: this.getAuthHeaders() }
      );

      if (response.data?.status && response.data?.data) {
        return response.data.data.map((candle: any[]) => ({
          timestamp: candle[0],
          open: candle[1],
          high: candle[2],
          low: candle[3],
          close: candle[4],
          volume: candle[5],
        }));
      }

      return [];
    } catch (error: any) {
      logger.error({ error: error.message, params }, 'Historical data fetch failed');
      return [];
    }
  }

  // --- Option Greeks ---

  async getOptionGreeks(name: string, expiry: string): Promise<ProviderGreeksData[]> {
    await this.ensureAuthenticated();

    try {
      const response = await this.api.post(
        '/rest/secure/angelbroking/marketData/v1/optionGreek',
        { name, expirydate: this.toAngelExpiryFormat(expiry) },
        { headers: this.getAuthHeaders() }
      );

      if (response.data?.status && response.data?.data) {
        return response.data.data;
      }

      return [];
    } catch (error: any) {
      logger.error({ error: error.message, name, expiry }, 'Option Greeks fetch failed');
      return [];
    }
  }

  // --- LTP ---

  async getLTP(
    exchangeSegment: ExchangeSegment,
    tokens: string[]
  ): Promise<Array<{ token: string; ltp: number }>> {
    await this.ensureAuthenticated();

    try {
      const response = await this.api.post(
        '/rest/secure/angelbroking/market/v1/quote/',
        {
          mode: 'LTP',
          exchangeTokens: { [QUOTE_EXCHANGE_MAP[exchangeSegment]]: tokens },
        },
        { headers: this.getAuthHeaders() }
      );

      if (response.data?.status && response.data?.data?.fetched) {
        return response.data.data.fetched.map((item: any) => ({
          token: item.symbolToken || item.token,
          ltp: parseFloat(item.ltp),
        }));
      }

      return [];
    } catch (error: any) {
      logger.error({ error: error.message }, 'LTP fetch failed');
      return [];
    }
  }

  // --- Quote (FULL mode: OI, bid/ask, OHLC) ---

  async getQuote(
    exchangeSegment: ExchangeSegment,
    tokens: string[],
    mode: QuoteMode = 'FULL'
  ): Promise<ProviderQuote[]> {
    await this.ensureAuthenticated();

    const CHUNK_SIZE = 50; // Angel One quote API limit per exchange
    const results: ProviderQuote[] = [];

    for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
      const chunk = tokens.slice(i, i + CHUNK_SIZE);

      try {
        const response = await this.api.post(
          '/rest/secure/angelbroking/market/v1/quote/',
          {
            mode,
            exchangeTokens: { [QUOTE_EXCHANGE_MAP[exchangeSegment]]: chunk },
          },
          { headers: this.getAuthHeaders() }
        );

        if (response.data?.status && response.data?.data?.fetched) {
          for (const item of response.data.data.fetched) {
            results.push({
              token: item.symbolToken || item.token,
              ltp: parseFloat(item.ltp) || 0,
              open: parseFloat(item.open) || 0,
              high: parseFloat(item.high) || 0,
              low: parseFloat(item.low) || 0,
              close: parseFloat(item.close) || 0,
              volume: parseInt(item.tradeVolume) || 0,
              oi: item.opnInterest !== undefined ? parseInt(item.opnInterest) || 0 : undefined,
              netChange: item.netChange !== undefined ? parseFloat(item.netChange) : undefined,
              percentChange: item.percentChange !== undefined ? parseFloat(item.percentChange) : undefined,
              avgPrice: item.avgPrice !== undefined ? parseFloat(item.avgPrice) : undefined,
              bid: item.depth?.buy?.[0]?.price,
              ask: item.depth?.sell?.[0]?.price,
              bidQty: item.depth?.buy?.[0]?.quantity,
              askQty: item.depth?.sell?.[0]?.quantity,
              depth: item.depth
                ? {
                    buy: (item.depth.buy || []).map((d: any) => ({
                      price: parseFloat(d.price) || 0,
                      quantity: parseInt(d.quantity) || 0,
                      orders: parseInt(d.orders) || 0,
                    })),
                    sell: (item.depth.sell || []).map((d: any) => ({
                      price: parseFloat(d.price) || 0,
                      quantity: parseInt(d.quantity) || 0,
                      orders: parseInt(d.orders) || 0,
                    })),
                  }
                : undefined,
              timestamp: Date.now(),
            });
          }
        }
      } catch (error: any) {
        logger.error({ error: error.message, exchangeSegment, chunkSize: chunk.length }, 'Quote fetch failed');
      }
    }

    return results;
  }

  // --- Market Status ---

  async getMarketStatus(exchange: Exchange): Promise<MarketStatus> {
    // Angel One doesn't have a dedicated market status endpoint.
    // We derive it from trading hours.
    const { isMarketOpen } = await import('@fno/shared');
    return {
      exchange,
      isOpen: isMarketOpen(exchange),
    };
  }

  // --- WebSocket ---

  createWebSocketConnection(config?: Partial<WebSocketConfig>): WebSocketConnection {
    return new AngelOneWebSocket({
      url: config?.url || WS_URL,
      authToken: config?.authToken || this.accessToken || '',
      apiKey: config?.apiKey || this.credentials?.apiKey || '',
      clientId: config?.clientId || this.credentials?.clientId || '',
      feedToken: config?.feedToken || this.feedToken || '',
    });
  }

  // --- Private Helpers ---

  private getAuthHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '',
      'X-ClientPublicIP': '',
      'X-MACAddress': '',
      'X-PrivateKey': this.credentials?.apiKey || '',
    };
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.isAuthenticated()) {
      if (this.credentials) {
        const result = await this.refreshAuth();
        if (!result.success) {
          throw new Error('Authentication required');
        }
      } else {
        throw new Error('Not authenticated');
      }
    }
  }

  private mapInstrument(raw: AngelInstrument): Instrument {
    const exchSeg = raw.exch_seg?.toLowerCase() || '';
    const exchange = this.resolveExchange(exchSeg);
    const instrumentType = this.resolveInstrumentType(raw.instrumenttype, exchSeg);
    // MCX has no exch_seg CM/FO split the way NSE/BSE do (raw rows just say
    // "mcx") — segment has to come from the resolved instrument type instead
    // of string-matching exch_seg, or every MCX future/option gets miscast
    // as segment "CM"/type "EQ" and silently drops out of every derivative filter.
    const segment = this.isDerivativeType(instrumentType) ? 'FO' as const : 'CM' as const;
    const underlying = this.resolveUnderlying(raw.symbol, raw.name, instrumentType);

    return {
      token: raw.token,
      symbol: raw.symbol,
      name: raw.name || raw.symbol,
      exchange,
      segment,
      instrumentType,
      underlying,
      // Angel One encodes strike as actual_price * 100 (e.g. "2260000.000000" for
      // a 22600 strike); non-option rows (futures/equity) use "-1.000000" as a
      // sentinel rather than omitting the field, so guard on > 0, not just truthy.
      strike: raw.strike && parseFloat(raw.strike) > 0 ? parseFloat(raw.strike) / 100 : undefined,
      optionType: this.resolveOptionType(raw.symbol, raw.instrumenttype),
      expiry: raw.expiry ? this.parseExpiry(raw.expiry) : undefined,
      lotSize: parseInt(raw.lotsize) || 1,
      tickSize: parseFloat(raw.tick_size) || 0.05,
      isFnO: segment === 'FO',
    };
  }

  private resolveExchange(exchSeg: string): Exchange {
    // Angel One's real exch_seg values (confirmed against a live scrip
    // master dump): "nse"/"nfo" for NSE cash/F&O, "bse"/"bfo" for BSE
    // cash/F&O, "mcx" for MCX. Derivatives use an unrelated 2-letter code
    // ("nfo"/"bfo"), not a "<exchange>_fo" pattern — a naive startsWith
    // check silently defaulted every BSE derivative (SENSEX/BANKEX
    // options and futures) to NSE, making them invisible to any query
    // scoped to exchange=BSE. NSE derivatives happened to still work only
    // because "nfo" fell through to the same default that happened to be
    // correct for NSE.
    if (exchSeg === 'bse' || exchSeg === 'bfo') return 'BSE';
    if (exchSeg === 'mcx') return 'MCX';
    return 'NSE';
  }

  private resolveInstrumentType(type: string, exchSeg: string): InstrumentType {
    const t = type?.toUpperCase() || '';
    if (t === 'FUTIDX') return 'FUTIDX';
    if (t === 'FUTSTK') return 'FUTSTK';
    if (t === 'FUTCOM') return 'FUTCOM';
    if (t === 'OPTIDX') return 'OPTIDX';
    if (t === 'OPTSTK') return 'OPTSTK';
    if (t === 'OPTFUT') return 'OPTFUT'; // MCX commodity options (options on futures)
    if (exchSeg.includes('fo')) return 'FUTSTK'; // default for F&O
    return 'EQ';
  }

  private isDerivativeType(type: InstrumentType): boolean {
    return (
      type === 'FUTIDX' || type === 'FUTSTK' || type === 'FUTCOM' ||
      type === 'OPTIDX' || type === 'OPTSTK' || type === 'OPTFUT'
    );
  }

  private resolveUnderlying(symbol: string, name: string, type: InstrumentType): string {
    // `name` is a clean underlying ticker across every instrument type in
    // Angel One's scrip master — confirmed for EQ/INDEX ("RELIANCE-EQ" ->
    // name "RELIANCE") and for derivatives ("SENSEX26AUGFUT" -> name
    // "SENSEX"; "RELIANCE29SEP261250CE" -> name "RELIANCE"). Prefer it
    // over regex-parsing `symbol`, which silently collapses distinct
    // underlyings that share a prefix — "SENSEX5026AUGFUT" (the SENSEX50
    // index) regex-extracts to "SENSEX" too, since the parse just stops at
    // the first digit, which merged SENSEX50's futures into SENSEX's
    // futures chain. Only fall back to the regex if `name` is ever absent.
    if (name) return name.toUpperCase().replace(/-EQ$/, '');
    const match = symbol.match(/^([A-Z]+?)(\d|$)/);
    return match ? match[1] : symbol;
  }

  private resolveOptionType(symbol: string, instrumentType: string): OptionType | undefined {
    if (!instrumentType?.includes('OPT')) return undefined;
    if (symbol.endsWith('CE')) return 'CE';
    if (symbol.endsWith('PE')) return 'PE';
    return undefined;
  }

  private parseExpiry(expiry: string): string {
    if (!expiry) return '';
    // Already ISO ("2024-01-25" or "2024-01-25T00:00:00") — strip any time part.
    // NOTE: checked before the DDMMMYYYY branch below, and matched on '-' only
    // (not 'T') — Angel One's "27OCT2026" format legitimately contains a
    // capital T from the month abbreviation and would false-positive.
    if (expiry.includes('-')) return expiry.split('T')[0];

    // Format like "25JAN2024"
    const months: Record<string, string> = {
      JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
      JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
    };

    try {
      const day = expiry.slice(0, 2);
      const month = months[expiry.slice(2, 5).toUpperCase()];
      const year = expiry.slice(5);
      if (month) return `${year}-${month}-${day}`;
    } catch {
      // Fall through
    }

    return expiry;
  }

  /** Inverse of parseExpiry: ISO "2025-01-28" -> Angel One's "28JAN2025". */
  private toAngelExpiryFormat(isoExpiry: string): string {
    if (!/^\d{4}-\d{2}-\d{2}/.test(isoExpiry)) return isoExpiry; // Already provider format

    const monthNames = [
      'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
      'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
    ];

    const [year, month, day] = isoExpiry.slice(0, 10).split('-');
    return `${day}${monthNames[parseInt(month, 10) - 1]}${year}`;
  }
}

// ============================================================
// ANGEL ONE WEBSOCKET v2 IMPLEMENTATION
// ============================================================

class AngelOneWebSocket implements WebSocketConnection {
  private ws: any = null; // ws.WebSocket
  private config: WebSocketConfig;
  private tickCallbacks: TickCallback[] = [];
  private errorCallbacks: Array<(error: Error) => void> = [];
  private disconnectCallbacks: Array<(code: number, reason: string) => void> = [];
  private reconnectCallbacks: Array<() => void> = [];
  private connected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private subscriptions: Map<string, { token: string; exchangeSegment: ExchangeSegment; mode: SubscriptionMode }> = new Map();

  constructor(config: WebSocketConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    // Dynamic import for ws (Node.js)
    const { default: WebSocket } = await import('ws');

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.url, {
          headers: {
            'Authorization': `Bearer ${this.config.authToken}`,
            'x-api-key': this.config.apiKey,
            'x-client-code': this.config.clientId,
            'x-feed-token': this.config.feedToken,
          },
        });

        this.ws.on('open', () => {
          this.connected = true;
          this.reconnectAttempts = 0;
          logger.info('Angel One WebSocket connected');
          resolve();
        });

        this.ws.on('message', (data: Buffer) => {
          try {
            const ticks = this.parseBinaryMessage(data);
            if (ticks.length > 0) {
              this.tickCallbacks.forEach(cb => cb(ticks));
            }
          } catch (err: any) {
            logger.error({ error: err.message }, 'Failed to parse WebSocket message');
          }
        });

        this.ws.on('error', (error: Error) => {
          logger.error({ error: error.message }, 'WebSocket error');
          this.errorCallbacks.forEach(cb => cb(error));
          if (!this.connected) reject(error);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          this.connected = false;
          const reasonStr = reason.toString();
          logger.warn({ code, reason: reasonStr }, 'WebSocket disconnected');
          this.disconnectCallbacks.forEach(cb => cb(code, reasonStr));
          this.attemptReconnect();
        });

        this.ws.on('ping', () => {
          this.ws?.pong();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    this.maxReconnectAttempts = 0; // Prevent reconnection
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  subscribe(
    tokens: Array<{ token: string; exchangeSegment: ExchangeSegment; mode: SubscriptionMode }>
  ): void {
    if (!this.ws || !this.connected) {
      logger.warn('Cannot subscribe: WebSocket not connected');
      return;
    }

    // Group by exchange type
    const grouped: Record<number, string[]> = {};
    const mode = tokens[0]?.mode || 'SNAP_QUOTE';

    for (const t of tokens) {
      const exchCode = WS_EXCHANGE_CODES[t.exchangeSegment];
      if (!grouped[exchCode]) grouped[exchCode] = [];
      grouped[exchCode].push(t.token);
      this.subscriptions.set(`${t.exchangeSegment}:${t.token}`, t);
    }

    const tokenList = Object.entries(grouped).map(([exchType, tkns]) => ({
      exchangeType: parseInt(exchType),
      tokens: tkns,
    }));

    const payload = {
      correlationID: `sub_${Date.now()}`,
      action: 1, // Subscribe
      params: {
        mode: WS_MODE_CODES[mode],
        tokenList,
      },
    };

    this.ws.send(JSON.stringify(payload));
    logger.info({ count: tokens.length, mode }, 'WebSocket subscribed');
  }

  unsubscribe(tokens: Array<{ token: string; exchangeSegment: ExchangeSegment }>): void {
    if (!this.ws || !this.connected) return;

    const grouped: Record<number, string[]> = {};

    for (const t of tokens) {
      const exchCode = WS_EXCHANGE_CODES[t.exchangeSegment];
      if (!grouped[exchCode]) grouped[exchCode] = [];
      grouped[exchCode].push(t.token);
      this.subscriptions.delete(`${t.exchangeSegment}:${t.token}`);
    }

    const tokenList = Object.entries(grouped).map(([exchType, tkns]) => ({
      exchangeType: parseInt(exchType),
      tokens: tkns,
    }));

    const payload = {
      correlationID: `unsub_${Date.now()}`,
      action: 0, // Unsubscribe
      params: {
        mode: 3,
        tokenList,
      },
    };

    this.ws.send(JSON.stringify(payload));
    logger.info({ count: tokens.length }, 'WebSocket unsubscribed');
  }

  onTick(callback: TickCallback): void {
    this.tickCallbacks.push(callback);
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }

  onDisconnect(callback: (code: number, reason: string) => void): void {
    this.disconnectCallbacks.push(callback);
  }

  onReconnect(callback: () => void): void {
    this.reconnectCallbacks.push(callback);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  // --- Binary Message Parser ---

  private parseBinaryMessage(data: Buffer): Tick[] {
    const ticks: Tick[] = [];

    // Angel One WebSocket v2 binary format
    // Each message may contain multiple packets
    let offset = 0;

    while (offset < data.length) {
      try {
        // Check minimum packet size
        if (data.length - offset < 8) break;

        // Read subscription mode (1 byte) and exchange type (1 byte)
        const mode = data.readUInt8(offset);
        const exchangeType = data.readUInt8(offset + 1);

        // Read token (25 bytes, null-terminated string starting at offset+2)
        // In Angel One v2, token info varies by mode
        // This is a simplified parser — in production, follow exact binary spec

        let packetSize: number;
        switch (mode) {
          case 1: packetSize = 50;  break; // LTP mode
          case 2: packetSize = 130; break; // Quote mode
          case 3: packetSize = 170; break; // SnapQuote mode
          default: packetSize = data.length - offset; break;
        }

        if (offset + packetSize > data.length) break;

        const packet = data.subarray(offset, offset + packetSize);
        const tick = this.parseTickPacket(packet, mode, exchangeType);
        if (tick) ticks.push(tick);

        offset += packetSize;
      } catch (err) {
        // Skip malformed packet
        break;
      }
    }

    return ticks;
  }

  private parseTickPacket(
    packet: Buffer,
    mode: number,
    exchangeType: number
  ): Tick | null {
    try {
      // Simplified parsing — actual byte positions depend on Angel One v2 spec
      // Token is typically at bytes 2-26 (25 char null-terminated)
      const tokenBytes = packet.subarray(2, 27);
      const token = tokenBytes.toString('ascii').replace(/\0/g, '').trim();

      if (!token) return null;

      const exchange = this.exchangeTypeToExchange(exchangeType);

      // LTP starts at byte 27 (4 bytes, int32, needs /100)
      const ltp = packet.readInt32LE(27) / 100;

      const tick: Tick = {
        token,
        exchange,
        timestamp: Date.now(),
        ltp,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
      };

      // Quote mode has more fields
      if (mode >= 2 && packet.length >= 130) {
        tick.open = packet.readInt32LE(47) / 100;
        tick.high = packet.readInt32LE(51) / 100;
        tick.low = packet.readInt32LE(55) / 100;
        tick.close = packet.readInt32LE(59) / 100;
        tick.volume = packet.readInt32LE(35);
      }

      // SnapQuote mode adds OI and bid/ask
      if (mode >= 3 && packet.length >= 170) {
        tick.oi = packet.readInt32LE(63);
      }

      return tick;
    } catch {
      return null;
    }
  }

  private exchangeTypeToExchange(type: number): Exchange {
    switch (type) {
      case 1: return 'NSE';
      case 2: return 'NSE';
      case 3: return 'BSE';
      case 4: return 'BSE';
      case 5: return 'MCX';
      default: return 'NSE';
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max WebSocket reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts), // Exponential backoff
      30000 // Max 30 seconds
    );

    logger.info(
      { attempt: this.reconnectAttempts, delayMs: delay },
      'Attempting WebSocket reconnect'
    );

    setTimeout(async () => {
      try {
        await this.connect();
        this.reconnectCallbacks.forEach(cb => cb());

        // Re-subscribe to all previous subscriptions
        if (this.subscriptions.size > 0) {
          this.subscribe(Array.from(this.subscriptions.values()));
        }
      } catch (err: any) {
        logger.error({ error: err.message }, 'WebSocket reconnect failed');
      }
    }, delay);
  }
}
