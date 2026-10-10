// ============================================================
// API CLIENT
// ============================================================
// Centralized HTTP client for backend API communication.
// All API calls go through this module.
// ============================================================

import type { MeasurementReport } from './use-measurement';
import type {
  OptionChain,
  FuturesChainResponse,
  MarketQuote,
  MarketBias,
  IntelligenceScore,
  TradeSetup,
  FnoScannerRow,
  Alert,
  DetectedChartPattern,
  InstitutionalFlowSnapshot,
  NextDayBias,
  InstitutionalCommentary,
  InstitutionalFlowPrediction,
  PredictionAccuracyStats,
  WinRateAnalytics,
  TradeSetupRecord,
  NewsArticle,
  CorporateAction,
  MarketScanResult,
  StrategyTrackRecord,
  FiiDiiActivity,
  StructureBlock,
  SetupWatchRow,
  StructureLifecycleView,
  BiasSnapshot,
  PaperTradesResponse,
  ReadOnlyMeta,
} from '@fno/shared';

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

  /** Like request(), but keeps the response's `meta` (read-only source, as-of time, age) beside the data. */
  async requestEnvelope<T>(endpoint: string, options: ApiOptions = {}): Promise<{ data: T; meta: ReadOnlyMeta | undefined }> {
    const { method = 'GET', body, headers = {}, signal } = options;
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.sessionToken ? { Authorization: `Bearer ${this.sessionToken}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const json = await response.json();
    if (!response.ok || !json.success) {
      throw new ApiError(json.error?.message || `API error: ${response.status}`, json.error?.code || 'UNKNOWN_ERROR', response.status);
    }
    return { data: json.data as T, meta: json.meta as ReadOnlyMeta | undefined };
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

  /** The newest F&O scan the server has recorded (read-only; `meta` says where it came from and how old it is). */
  async getFnoScanner(exchange = 'NSE') {
    return this.requestEnvelope<FnoScannerRow[]>(`/api/instruments/fno-scanner?exchange=${exchange}`);
  }

  /** The newest market scan the server has recorded. Read-only: opening a page never runs a scan. */
  async getMarketScan() {
    return this.requestEnvelope<MarketScanResult | null>('/api/market-scanner');
  }

  /** An EXPLICIT scan (the "Run scan" button). It records decision rows like the background scan; a page load never calls it. */
  async runMarketScan() {
    return this.requestEnvelope<MarketScanResult>('/api/market-scanner/refresh', { method: 'POST', body: {} });
  }

  /** Every paper trade (open and closed) with live tracking, estimated costs and an explicit status. Read-only. */
  async getPaperTrades(limit = 500) {
    return this.get<PaperTradesResponse>(`/api/paper-trades?limit=${limit}`);
  }

  /** The measurement report: cohorts, denominators, cost availability, conservative-fill sensitivity, payoff grading. Read-only. */
  async getMeasurement() {
    return this.get<MeasurementReport>('/api/diagnostics/measurement');
  }

  /** Structure engine: every symbol's running lifecycle (WATCH → DEVELOPING → CONFIRMED → ENTRY/ACTIVE). Read-only. */
  async getStructureWatchlist() {
    return this.get<{ enabled: boolean; day: string; rows: StructureLifecycleView[] }>('/api/structure/watchlist');
  }

  async getStrategyTrackRecord() {
    return this.get<StrategyTrackRecord>('/api/strategy-scanner/track-record');
  }

  async getFiiDii() {
    return this.get<FiiDiiActivity | null>('/api/fii-dii');
  }

  async getFiiDiiHistory(limit = 30) {
    return this.get<FiiDiiActivity[]>(`/api/fii-dii/history?limit=${limit}`);
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

  async getAllIndexQuotes() {
    return this.get<MarketQuote[]>('/api/market/all-indices');
  }

  async getChartPatterns() {
    return this.get<DetectedChartPattern[]>('/api/market/chart-patterns');
  }

  async getInstitutionalSnapshot() {
    return this.get<InstitutionalFlowSnapshot>('/api/institutional-flow/snapshot');
  }

  async getNextDayBias() {
    return this.get<NextDayBias[]>('/api/institutional-flow/next-day-bias');
  }

  async getInstitutionalCommentary() {
    return this.get<InstitutionalCommentary>('/api/institutional-flow/commentary');
  }

  async getPredictionHistory(symbol: string, limit = 30) {
    return this.get<InstitutionalFlowPrediction[]>(`/api/institutional-flow/predictions?symbol=${symbol}&limit=${limit}`);
  }

  async getPredictionAccuracy(symbol: string) {
    return this.get<PredictionAccuracyStats>(`/api/institutional-flow/accuracy?symbol=${symbol}`);
  }

  async getWinRateAnalytics(mode: 'ALL' | 'INTRADAY' | 'POSITIONAL' = 'ALL', since?: number, logicVersion: string = 'all') {
    return this.get<WinRateAnalytics>(
      `/api/backtesting/win-rate?mode=${mode}${since != null ? `&since=${since}` : ''}${logicVersion !== 'all' ? `&logicVersion=${encodeURIComponent(logicVersion)}` : ''}`
    );
  }

  async getTradeSetupHistory(limit = 100) {
    return this.get<TradeSetupRecord[]>(`/api/backtesting/trade-setups?limit=${limit}`);
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

  /**
   * @deprecated The terminal no longer calls this. GET /api/market/bias/:symbol runs the decision engine (it can mint a
   * paper trade and writes decision records), so a page load must not use it. Kept only for external callers.
   */
  async getMarketBias(symbol: string, exchange = 'NSE', mode: 'INTRADAY' | 'POSITIONAL' = 'INTRADAY') {
    return this.get<{ bias: MarketBias; score: IntelligenceScore; tradeSetup: TradeSetup; structure?: StructureBlock; setupWatch?: SetupWatchRow[] }>(
      `/api/market/bias/${symbol}?exchange=${exchange}&mode=${mode}`
    );
  }

  /** The last assessment of a symbol (the engine's cached result, else the last decision record). Read-only. */
  async getBiasSnapshot(symbol: string, exchange = 'NSE', mode: 'INTRADAY' | 'POSITIONAL' = 'INTRADAY') {
    return this.requestEnvelope<BiasSnapshot | null>(`/api/market/bias-snapshot/${symbol}?exchange=${exchange}&mode=${mode}`);
  }

  async getNews(symbol: string) {
    return this.get<NewsArticle[]>(`/api/news/${symbol}`);
  }

  async getUpcomingCorporateActions() {
    return this.get<CorporateAction[]>('/api/corporate-actions');
  }

  async getCorporateActionsForSymbol(symbol: string) {
    return this.get<CorporateAction[]>(`/api/corporate-actions/${symbol}`);
  }

  async getHealth() {
    return this.get<any>('/api/health');
  }

  async getAlerts(limit = 50, opts: { type?: string; severity?: string } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (opts.type) params.set('type', opts.type);
    if (opts.severity) params.set('severity', opts.severity);
    return this.get<Alert[]>(`/api/alerts?${params.toString()}`);
  }

  async chatWithAssistant(message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) {
    return this.post<{ reply: string }>('/api/ai-assistant/chat', { message, history });
  }

  // --- System learning / self-audit ---

  async getLearningSummary(date?: string) {
    return this.get<any>(`/api/learning/summary${date ? `?date=${date}` : ''}`);
  }

  async getLearningEvents(date?: string) {
    return this.get<any>(`/api/learning/events${date ? `?date=${date}` : ''}`);
  }

  async getLearningRecurring() {
    return this.get<any>('/api/learning/recurring');
  }

  async getLearningExpected() {
    return this.get<any>('/api/learning/expected');
  }

  async getLearningUnresolved() {
    return this.get<any>('/api/learning/unresolved');
  }

  async getLearningRegressions() {
    return this.get<any>('/api/learning/regressions');
  }

  async getLearningProtections() {
    return this.get<any>('/api/learning/protections');
  }

  async getLearningReviewQueue() {
    return this.get<any>('/api/learning/review');
  }

  async getLearningHistory(days = 30) {
    return this.get<any>(`/api/learning/history?days=${days}`);
  }

  /**
   * Records a human decision on a trading-path finding.
   *
   * This records consent. It does not apply anything: the backend has no
   * code path that edits a trading module.
   */
  async submitLearningReview(
    eventId: number,
    body: { decision: string; reviewer: string; note?: string; fix_description?: string }
  ) {
    return this.post<{ ok: boolean; status: string; message: string }>(`/api/learning/review/${eventId}`, body);
  }

  // --- Loss attribution (read-only; every figure is a simulated paper-trade outcome) ---

  private lossAttributionQuery(opts: { scope?: string; since?: string; until?: string; logicVersion?: string }): string {
    const params = new URLSearchParams();
    if (opts.scope) params.set('scope', opts.scope);
    if (opts.since) params.set('since', opts.since);
    if (opts.until) params.set('until', opts.until);
    if (opts.logicVersion && opts.logicVersion !== 'all') params.set('logicVersion', opts.logicVersion);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }

  async getLossAttributionReport(opts: { scope?: string; since?: string; until?: string; logicVersion?: string } = {}) {
    return this.get<unknown>(`/api/loss-attribution/report${this.lossAttributionQuery(opts)}`);
  }

  async getLossAttributionSplit(opts: { scope?: string; since?: string; until?: string; logicVersion?: string } = {}) {
    return this.get<unknown>(`/api/loss-attribution/split${this.lossAttributionQuery(opts)}`);
  }

  async getLossAttributionGates(opts: { since?: string; until?: string } = {}) {
    return this.get<unknown>(`/api/loss-attribution/gates${this.lossAttributionQuery(opts)}`);
  }

  async getLossAttributionShadow(opts: { since?: string; until?: string } = {}) {
    return this.get<unknown>(`/api/loss-attribution/shadow${this.lossAttributionQuery(opts)}`);
  }

  // --- Signal diagnostics (read-only; every figure is a simulated paper-trade outcome) ---

  private diagnosticsQuery(opts: DiagnosticsFilter): string {
    const params = new URLSearchParams();
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
    if (opts.instrument) params.set('instrument', opts.instrument);
    if (opts.strategyVersion) params.set('strategyVersion', opts.strategyVersion);
    if (opts.costVersion) params.set('costVersion', opts.costVersion);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }

  async getDiagnosticsSummary(opts: DiagnosticsFilter = {}) {
    return this.get<unknown>(`/api/diagnostics/summary${this.diagnosticsQuery(opts)}`);
  }

  async getDiagnosticsRejections(opts: DiagnosticsFilter = {}) {
    return this.get<unknown>(`/api/diagnostics/rejections${this.diagnosticsQuery(opts)}`);
  }

  async getDiagnosticsCensus(opts: DiagnosticsFilter = {}) {
    return this.get<unknown>(`/api/diagnostics/census${this.diagnosticsQuery(opts)}`);
  }

  async getDiagnosticsGrades(opts: DiagnosticsFilter = {}) {
    return this.get<unknown>(`/api/diagnostics/grades${this.diagnosticsQuery(opts)}`);
  }

  async getDiagnosticsLeakage(opts: DiagnosticsFilter = {}) {
    return this.get<unknown>(`/api/diagnostics/leakage${this.diagnosticsQuery(opts)}`);
  }

  async getDiagnosticsPerformance(opts: DiagnosticsFilter = {}) {
    return this.get<unknown>(`/api/diagnostics/performance${this.diagnosticsQuery(opts)}`);
  }

  async getDiagnosticsOpportunity(opts: DiagnosticsFilter = {}) {
    return this.get<unknown>(`/api/diagnostics/opportunity${this.diagnosticsQuery(opts)}`);
  }

  async getDiagnosticsMajorMoves(opts: DiagnosticsFilter = {}) {
    return this.get<unknown>(`/api/diagnostics/major-moves${this.diagnosticsQuery(opts)}`);
  }

  async getDiagnosticsTriggers() {
    return this.get<unknown>('/api/diagnostics/triggers');
  }

  async getDiagnosticsShadow(opts: DiagnosticsFilter = {}) {
    return this.get<unknown>(`/api/diagnostics/shadow${this.diagnosticsQuery(opts)}`);
  }

  async getDiagnosticsVersions() {
    return this.get<unknown>('/api/diagnostics/versions');
  }

  /** Per-setup measurement (net R, cost quality, rejection, fill, graded outcome) for the Trade Setup card. */
  async getSetupOutcomes(lifecycleIds: string[]) {
    return this.get<unknown>(`/api/diagnostics/setup-outcomes?lifecycleIds=${encodeURIComponent(lifecycleIds.join(','))}`);
  }

  /** Phase 8: recent snapshotted decisions. */
  async getDecisionList(symbol?: string) {
    return this.get<{ rows: import('@fno/shared').DecisionListRow[] }>(`/api/diagnostics/decisions${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`);
  }

  /** Phase 8: one decision end to end (replay = re-derive offline and compare). */
  async getDecision(snapshotId: string, replay = false) {
    return this.get<import('@fno/shared').DecisionDiagnosticsView>(`/api/diagnostics/decision/${encodeURIComponent(snapshotId)}${replay ? '?replay=1' : ''}`);
  }

  /** Full replay: the whole decision path re-run from the poll's I/O tape, compared with what the live poll did. */
  async getDecisionFullReplay(snapshotId: string) {
    return this.get<import('../components/signal-diagnostics/signal-engine-panel').FullReplayReport>(`/api/diagnostics/decision/${encodeURIComponent(snapshotId)}/replay-full`);
  }

  /** Order blocks (OB-2.0) beside the live vote, the Dhan order-flow feed and OF1 candidates — shadow only. */
  async getOrderFlowReport(opts: DiagnosticsFilter = {}) {
    return this.get<import('../components/signal-diagnostics/order-flow-panel').OrderFlowReport>(`/api/diagnostics/order-flow${this.diagnosticsQuery(opts)}`);
  }

  /** Pre-registered shadow experiments: entry filters and exit rules, measured on the paper trades — never traded. */
  async getShadowRules(opts: DiagnosticsFilter = {}) {
    return this.get<import('../components/signal-diagnostics/signal-engine-panel').ShadowRulesReport>(`/api/diagnostics/shadow-rules${this.diagnosticsQuery(opts)}`);
  }

  /** The slot's behaviour (NO TRADE, fallback, rejections) and forward validation. */
  async getSignalEngineMetrics(opts: DiagnosticsFilter = {}) {
    return this.get<import('../components/signal-diagnostics/signal-engine-panel').SignalEngineMetrics>(`/api/diagnostics/signal-engine${this.diagnosticsQuery(opts)}`);
  }
}

export interface DiagnosticsFilter {
  from?: string;
  to?: string;
  instrument?: string;
  strategyVersion?: string;
  costVersion?: string;
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
