// ============================================================
// API CLIENT
// ============================================================
// Centralized HTTP client for backend API communication.
// All API calls go through this module.
// ============================================================

import type { OptionChain, FuturesChainResponse, MarketQuote, MarketBias, IntelligenceScore, TradeSetup, FnoScannerRow, Alert } from '@fno/shared';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

class ApiClient {
  private baseUrl: string;
  private sessionToken: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  setSessionToken(token: string | null) {
    this.sessionToken = token;
  }

  async request<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
    const { method = 'GET', body, headers = {}, signal } = options;

    const allHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headers,
    };

    if (this.sessionToken) {
      allHeaders['Authorization'] = `Bearer ${this.sessionToken}`;
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: allHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new ApiError(
        data.error?.message || `API error: ${response.status}`,
        data.error?.code || 'UNKNOWN_ERROR',
        response.status
      );
    }

    return data.data;
  }

  // --- Convenience Methods ---

  get<T>(endpoint: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>(endpoint, { signal });
  }

  post<T>(endpoint: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>(endpoint, { method: 'POST', body, signal });
  }

  put<T>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>(endpoint, { method: 'PUT', body });
  }

  delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }

  // --- Domain Methods ---

  async login(credentials: {
    apiKey: string;
    clientId: string;
    password: string;
    totpSecret?: string;
  }) {
    const result = await this.post<{ sessionToken: string; expiresAt: number }>(
      '/api/auth/login',
      credentials
    );
    this.sessionToken = result.sessionToken;
    return result;
  }

  async getAuthStatus() {
    return this.get<{ authenticated: boolean; provider: string }>('/api/auth/status');
  }

  async searchInstruments(query: string, exchange?: string) {
    const params = new URLSearchParams({ q: query });
    if (exchange) params.set('exchange', exchange);
    return this.get<any[]>(`/api/instruments?${params}`);
  }

  async getFnOStocks() {
    return this.get<any[]>('/api/instruments/fno');
  }

  async getFnoScanner(exchange = 'NSE') {
    return this.get<FnoScannerRow[]>(`/api/instruments/fno-scanner?exchange=${exchange}`);
  }

  async getIndices() {
    return this.get<any[]>('/api/instruments/indices');
  }

  async getExpiries(symbol: string, exchange = 'NSE') {
    return this.get<string[]>(`/api/instruments/expiries/${symbol}?exchange=${exchange}`);
  }

  async getMarketStatus(exchange = 'NSE') {
    return this.get<any>(`/api/market/status?exchange=${exchange}`);
  }

  async getIndexQuotes() {
    return this.get<MarketQuote[]>('/api/market/indices');
  }

  async getHistoricalData(token: string, from: string, to: string, exchange = 'NSE', interval = 'ONE_DAY') {
    return this.get<any[]>(
      `/api/market/historical/${token}?exchange=${exchange}&interval=${interval}&from=${from}&to=${to}`
    );
  }

  async getOptionGreeks(name: string, expiry: string) {
    return this.get<any[]>(`/api/market/greeks/${name}?expiry=${expiry}`);
  }

  async getOptionChain(
    symbol: string,
    opts: { exchange?: string; expiry?: string; strikeRange?: number } = {}
  ) {
    const params = new URLSearchParams();
    if (opts.exchange) params.set('exchange', opts.exchange);
    if (opts.expiry) params.set('expiry', opts.expiry);
    if (opts.strikeRange) params.set('strikeRange', String(opts.strikeRange));
    const qs = params.toString();
    return this.get<OptionChain>(`/api/option-chain/${symbol}${qs ? `?${qs}` : ''}`);
  }

  async getFutures(symbol: string, exchange = 'NSE') {
    return this.get<FuturesChainResponse>(`/api/futures/${symbol}?exchange=${exchange}`);
  }

  async getMarketBias(symbol: string, exchange = 'NSE') {
    return this.get<{ bias: MarketBias; score: IntelligenceScore; tradeSetup: TradeSetup }>(
      `/api/market/bias/${symbol}?exchange=${exchange}`
    );
  }

  async getHealth() {
    return this.get<any>('/api/health');
  }

  async getAlerts(limit = 50) {
    return this.get<Alert[]>(`/api/alerts?limit=${limit}`);
  }

  async chatWithAssistant(message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) {
    return this.post<{ reply: string }>('/api/ai-assistant/chat', { message, history });
  }
}

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export const api = new ApiClient(API_BASE);
