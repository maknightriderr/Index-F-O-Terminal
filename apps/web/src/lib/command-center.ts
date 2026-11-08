// ============================================================
// COMMAND CENTER — pure views over the fresh-start paper cohort
// ============================================================
// Everything here is derived from /api/fresh-start/status (positions, candidates, evaluations, performance) and the
// option chain. Nothing is invented: a value the server did not send is null and renders as "—". Positions are
// marked from the server's own fields only (entry, stops, highest bid seen); there is no live mark in the status
// payload, so no unrealised P&L is claimed for an open position.
// ============================================================

import type { FreshStartStatus, FreshStrategyPerformance, OptionChain, OptionChainLeg } from '@fno/shared';

export const STRATEGY_NAMES: Record<string, string> = {
  NEW_ORB_RETEST_V1: 'ORB retest',
  NEW_VWAP_PULLBACK_V1: 'VWAP pullback',
  NEW_PREVIOUS_SESSION_SWEEP_V1: 'PDH/PDL sweep',
  NEW_FIRST_OPENING_PULLBACK_V1: 'Opening pullback',
  NEW_MOMENTUM_BREAKOUT_V1: 'Momentum breakout',
  NEW_TREND_FLAG_V1: 'Trend flag',
  NEW_EVENT_BREAKOUT_V1: 'Event breakout',
  NEW_RS_STOCK_V1: 'Stock in play',
  NEW_INDEX_BREADTH_V1: 'Index breadth',
  NEW_MCX_FLOW_V1: 'MCX order flow',
};
/** 2.0: the 1.x strategies run in shadow — evaluated and recorded, never traded (packages/analytics FRESH_SHADOW_STRATEGIES). */
export const SHADOW_STRATEGY_IDS: ReadonlySet<string> = new Set(['NEW_ORB_RETEST_V1', 'NEW_VWAP_PULLBACK_V1', 'NEW_PREVIOUS_SESSION_SWEEP_V1', 'NEW_FIRST_OPENING_PULLBACK_V1', 'NEW_MOMENTUM_BREAKOUT_V1', 'NEW_TREND_FLAG_V1', 'NEW_EVENT_BREAKOUT_V1']);
export const STRATEGY_IDS = Object.keys(STRATEGY_NAMES);
/** Dhan order-flow engine v2 (separate paper book): paper-traded, never evaluated by the fresh-start radar. */
export const DHAN_STRATEGY_NAMES: Record<string, string> = {
  DHAN_A_SWEEP_ABSORPTION: 'Dhan A · sweep + absorption',
  DHAN_B_IMBALANCE_BREAKOUT: 'Dhan B · imbalance breakout',
  DHAN_C_FAILED_AUCTION_CVD: 'Dhan C · failed auction + CVD',
  DHAN_D_VWAP_PROFILE_REJECTION: 'Dhan D · VWAP / profile rejection',
  DHAN_EXPIRY_GAMMA: 'Dhan expiry gamma',
};
/** Every strategy with paper trades (Strategy Lab tabs, heatmap, promotion gates). */
export const PAPER_STRATEGY_IDS = [...STRATEGY_IDS, ...Object.keys(DHAN_STRATEGY_NAMES)];
export const strategyName = (id: string) => STRATEGY_NAMES[id] ?? DHAN_STRATEGY_NAMES[id] ?? id.replace(/^NEW_|_V\d+$/g, '').replaceAll('_', ' ').toLowerCase();
/** A radar / table column header: the name, marked when the strategy now runs in shadow (its past trades keep the plain name). */
export const strategyHeader = (id: string) => strategyName(id) + (SHADOW_STRATEGY_IDS.has(id) ? ' (shadow)' : '');

/** The engine's sizing rule (packages/analytics fresh-start/paper.ts FRESH_RISK_PER_TRADE): 0.5% of capital per trade. */
export const RISK_FRACTION = 0.005;
/** The cohort pauses new entries at a 5% cumulative net loss (FRESH_COHORT_DRAWDOWN_FRACTION). */
export const COHORT_DRAWDOWN_FRACTION = 0.05;
/** A strategy's statistics are not judged before this many closed trades. */
export const MIN_SAMPLE = 30;

export interface PositionView {
  id: string;
  strategy: string;
  strategyLabel: string;
  direction: 'BULLISH' | 'BEARISH';
  side: 'CE' | 'PE';
  instrument: string;
  contract: string;
  expiry: string | null;
  status: 'OPEN' | 'EXIT_PENDING' | 'CLOSED';
  session: string;
  openedAt: number;
  closedAt: number | null;
  entry: number;
  exit: number | null;
  quantity: number;
  units: number;
  riskCurrency: number;
  emergencyStop: number;
  currentStop: number;
  highBid: number;
  underlyingRef: number;
  underlyingStop: number;
  underlyingTarget: number;
  maxFavorable: number;
  exitReason: string | null;
  netPnl: number | null;
  r: number | null;
  fees: number | null;
  delta: number | null;
  market: string;
  /** The exit monitor's latest executable bid for a held position (display only), or null. */
  markBid: number | null;
  markAt: number | null;
  /** Order-flow SHADOW tag recorded at entry (1.8): ALIGNED / NEUTRAL / OPPOSED / UNAVAILABLE; UNTAGGED before 1.8. */
  orderFlow: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** One stored position, or null when its state is not a readable paper position (never half-rendered). */
export function toPositionView(row: FreshStartStatus['positions'][number]): PositionView | null {
  const s = obj(row.state);
  const c = obj(s.candidate), k = obj(s.contract), ev = obj(k.evidence);
  const id = str(s.id), entry = num(s.entry), quantity = num(s.quantity), openedAt = num(s.openedAt);
  const direction = c.direction === 'BULLISH' || c.direction === 'BEARISH' ? c.direction : null;
  const state = s.state === 'OPEN' || s.state === 'EXIT_PENDING' || s.state === 'CLOSED' ? s.state : null;
  if (!id || entry == null || quantity == null || openedAt == null || !direction || !state) return null;
  const multiplier = num(k.multiplier) ?? 1;
  const risk = num(s.originalRiskCurrency) ?? 0;
  const net = num(s.netPnl);
  const instrument = str(ev.underlying) ?? str(c.instrument) ?? '—';
  const strike = num(ev.strike) ?? (typeof ev.strike === 'string' ? Number(ev.strike) : null);
  const side = direction === 'BULLISH' ? 'CE' : 'PE';
  const strategy = str(c.strategy) ?? row.strategy;
  return {
    id,
    strategy,
    strategyLabel: strategyName(strategy),
    direction,
    side,
    instrument,
    contract: strike != null && Number.isFinite(strike) ? `${instrument} ${strike} ${side}` : str(k.id) ?? `${instrument} ${side}`,
    expiry: str(ev.expiry),
    status: state,
    session: row.session,
    openedAt,
    closedAt: state === 'CLOSED' ? num(s.lastEventAt) : null,
    entry,
    exit: num(s.exitPrice),
    quantity,
    units: quantity * multiplier,
    riskCurrency: risk,
    emergencyStop: num(s.emergencyStop) ?? 0,
    currentStop: num(s.currentStop) ?? 0,
    highBid: num(s.highBid) ?? entry,
    underlyingRef: num(c.referenceEntry) ?? 0,
    underlyingStop: num(c.stop) ?? 0,
    underlyingTarget: num(c.target) ?? 0,
    maxFavorable: num(s.maxUnderlyingFavorable) ?? 0,
    exitReason: str(s.exitReason),
    netPnl: net,
    r: net != null && risk > 0 ? net / risk : null,
    fees: num(s.estimatedFees),
    delta: num(k.delta),
    market: str(k.market) ?? '—',
    markBid: null,
    markAt: null,
    orderFlow: str(obj(obj(c.evidence).orderFlow).alignment) ?? 'UNTAGGED',
  };
}

export function positionViews(status: FreshStartStatus | null): PositionView[] {
  if (!status) return [];
  return status.positions.flatMap((p) => {
    const v = toPositionView(p);
    if (!v) return [];
    const m = v.status !== 'CLOSED' ? status.feedQualification?.marks?.[v.id] : undefined;
    if (m && Number.isFinite(m.bid) && m.bid > 0) {
      v.markBid = m.bid;
      v.markAt = m.at;
    }
    return [v];
  });
}

/** IST calendar day (YYYY-MM-DD) of an epoch-ms instant. */
export function istDay(ms: number): string {
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
}

export interface AccountView {
  capital: number | null;
  riskPerTrade: number | null;
  cohortNet: number;
  todayNet: number;
  todayClosed: number;
  todayWins: number;
  todayLosses: number;
  todayTrades: number;
  open: number;
  openRisk: number;
  /** Cumulative loss as a fraction of the cohort pause limit, 0..1 (0 when the cohort is flat or up). */
  drawdownUsed: number;
  drawdownPct: number;
}

export function accountView(status: FreshStartStatus | null, positions: PositionView[], now: number): AccountView {
  const capital = status?.capital ?? null;
  const today = istDay(now);
  const closed = positions.filter((p) => p.status === 'CLOSED');
  const cohortNet = closed.reduce((a, p) => a + (p.netPnl ?? 0), 0);
  const todayClosed = closed.filter((p) => p.closedAt != null && istDay(p.closedAt) === today);
  const open = positions.filter((p) => p.status !== 'CLOSED');
  const loss = Math.max(0, -cohortNet);
  return {
    capital,
    riskPerTrade: capital != null ? capital * RISK_FRACTION : null,
    cohortNet,
    todayNet: todayClosed.reduce((a, p) => a + (p.netPnl ?? 0), 0),
    todayClosed: todayClosed.length,
    todayWins: todayClosed.filter((p) => (p.netPnl ?? 0) > 0).length,
    todayLosses: todayClosed.filter((p) => (p.netPnl ?? 0) < 0).length,
    todayTrades: positions.filter((p) => istDay(p.openedAt) === today).length,
    open: open.length,
    openRisk: open.reduce((a, p) => a + p.riskCurrency, 0),
    drawdownUsed: capital ? Math.min(1, loss / (COHORT_DRAWDOWN_FRACTION * capital)) : 0,
    drawdownPct: capital ? (loss / capital) * 100 : 0,
  };
}

/**
 * Where a position sits between its premium stop and its target premium, 0..1, using the best bid seen (the only
 * mark the status payload carries). Target premium is entry + 1.5R per unit (the engine's minimum net payoff).
 */
export function stopToTarget(p: PositionView): { stop: number; target: number; mark: number; markAt: number; entryAt: number } {
  const perUnitRisk = p.units > 0 ? p.riskCurrency / p.units : p.entry - p.currentStop;
  const target = p.entry + 1.5 * perUnitRisk;
  const span = target - p.currentStop;
  const clamp = (x: number) => (span > 0 ? Math.max(0, Math.min(1, (x - p.currentStop) / span)) : 0);
  const mark = p.markBid ?? p.highBid;
  return { stop: p.currentStop, target, mark, markAt: clamp(mark), entryAt: clamp(p.entry) };
}

export interface EquityPoint { at: number; equity: number; drawdown: number }

/** Net equity after each closed trade (oldest first), with the running drawdown from the peak. */
export function equityCurve(positions: PositionView[], capital: number): EquityPoint[] {
  const closed = positions.filter((p) => p.status === 'CLOSED' && p.netPnl != null).sort((a, b) => (a.closedAt ?? a.openedAt) - (b.closedAt ?? b.openedAt));
  let equity = capital, peak = capital;
  const out: EquityPoint[] = [];
  for (const p of closed) {
    equity += p.netPnl!;
    peak = Math.max(peak, equity);
    out.push({ at: p.closedAt ?? p.openedAt, equity, drawdown: peak - equity });
  }
  return out;
}

export const R_BUCKETS = ['≤−1', '−0.5', '0', '+0.5', '+1', '+1.5', '+2', '+2.5', '3+'] as const;

/** Closed trades by R multiple, in half-R buckets. */
export function rHistogram(positions: PositionView[]): Array<{ label: string; n: number; tone: 'loss' | 'flat' | 'win' }> {
  const counts = R_BUCKETS.map(() => 0);
  for (const p of positions) {
    if (p.status !== 'CLOSED' || p.r == null) continue;
    const r = p.r;
    const i = r <= -0.75 ? 0 : r < -0.25 ? 1 : r <= 0.25 ? 2 : r < 0.75 ? 3 : r < 1.25 ? 4 : r < 1.75 ? 5 : r < 2.25 ? 6 : r < 2.75 ? 7 : 8;
    counts[i]++;
  }
  return R_BUCKETS.map((label, i) => ({ label, n: counts[i], tone: i < 2 ? 'loss' : i === 2 ? 'flat' : 'win' }));
}

export const TIME_SLOTS = [
  { label: '09:15', from: 9 * 60 + 15, to: 9 * 60 + 45 },
  { label: '09:45', from: 9 * 60 + 45, to: 10 * 60 + 30 },
  { label: '10:30', from: 10 * 60 + 30, to: 11 * 60 + 30 },
  { label: '11:30', from: 11 * 60 + 30, to: 13 * 60 },
  { label: '13:00', from: 13 * 60, to: 14 * 60 + 30 },
  { label: '14:30', from: 14 * 60 + 30, to: 24 * 60 },
];
const istMinutes = (ms: number) => {
  const d = new Date(ms + 330 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** Mean R per closed trade by strategy and IST entry time. null = no trades in that cell. */
export function timeHeatmap(positions: PositionView[]): Array<{ strategy: string; label: string; cells: Array<{ r: number | null; n: number }> }> {
  return PAPER_STRATEGY_IDS.map((strategy) => ({
    strategy,
    label: strategyName(strategy),
    cells: TIME_SLOTS.map((slot) => {
      const xs = positions.filter((p) => p.strategy === strategy && p.status === 'CLOSED' && p.r != null && istMinutes(p.openedAt) >= slot.from && istMinutes(p.openedAt) < slot.to);
      return { r: xs.length ? xs.reduce((a, p) => a + p.r!, 0) / xs.length : null, n: xs.length };
    }),
  }));
}

/** Closed trades by exit reason (the reason prefix before any "+" annotation). */
export function exitReasons(positions: PositionView[]): Array<{ reason: string; n: number; net: number }> {
  const m = new Map<string, { n: number; net: number }>();
  for (const p of positions) {
    if (p.status !== 'CLOSED') continue;
    const reason = (p.exitReason ?? 'UNKNOWN').split('+')[0];
    const e = m.get(reason) ?? { n: 0, net: 0 };
    e.n++;
    e.net += p.netPnl ?? 0;
    m.set(reason, e);
  }
  return [...m.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.n - a.n);
}

export interface GateCheck { rule: string; value: string; progress: number; ok: boolean }

/** The promotion checklist for one strategy: when its paper results may be trusted. Not an approval. */
export function promotionGate(p: FreshStrategyPerformance | undefined): GateCheck[] {
  const closed = p?.closed ?? 0;
  const sessions = p?.independentSessions ?? 0;
  const lower = p?.winRate95?.[0] ?? null;
  const exp = p?.expectancyR ?? null;
  const pf = p?.profitFactor ?? null;
  return [
    { rule: `Closed trades ≥ ${MIN_SAMPLE}`, value: `${closed} / ${MIN_SAMPLE}`, progress: Math.min(1, closed / MIN_SAMPLE), ok: closed >= MIN_SAMPLE },
    { rule: 'Independent sessions ≥ 20', value: `${sessions} / 20`, progress: Math.min(1, sessions / 20), ok: sessions >= 20 },
    { rule: 'Expectancy > 0 R after costs', value: exp == null ? '—' : `${exp >= 0 ? '+' : '−'}${Math.abs(exp).toFixed(2)}R`, progress: exp == null ? 0 : exp > 0 ? 1 : 0, ok: exp != null && exp > 0 },
    { rule: 'Profit factor ≥ 1.3', value: pf == null ? '—' : pf.toFixed(2), progress: pf == null ? 0 : Math.min(1, pf / 1.3), ok: pf != null && pf >= 1.3 },
    { rule: 'Win-rate 95% lower bound ≥ 40%', value: lower == null ? '—' : `${(lower * 100).toFixed(0)}%`, progress: lower == null ? 0 : Math.min(1, lower / 0.4), ok: lower != null && lower >= 0.4 },
  ];
}

// ---------------- Setup radar ----------------

export type RadarState = 'IN_TRADE' | 'FILLED' | 'REFUSED' | 'NO_SETUP' | 'NOT_EVALUATED';
export interface RadarCell { state: RadarState; code: string | null; at: number | null; detail?: string | null }

/** Short plain-English reasons for the engine's refusal codes and gate details (Radar cells). */
const RADAR_REASONS: Readonly<Record<string, string>> = Object.freeze({
  SHADOW_STRATEGY: 'Shadow: setup recorded, not traded',
  RS_NOT_A_STOCK: 'Stocks only', RS_INTEL_STALE: 'Scan data stale', RS_BEFORE_10_00: 'Starts 10:00', RS_WEAK: 'Not leading / lagging NIFTY',
  RS_OI_NOT_ALIGNED: 'Futures OI not aligned', RS_SECTOR_AGAINST: 'Sector against', RS_LIQUIDITY_OR_IV: 'Spread wide / IV high',
  RS_15M_AGAINST: '15m trend against', RS_NOT_HOLDING_VWAP: 'Not holding VWAP', RS_NO_TRIGGER: 'Waiting for pullback / base break', RS_RISK_TOO_WIDE: 'Risk > 1.2 ATR',
  IDX_NOT_AN_INDEX: 'Indices only', IDX_INTEL_STALE: 'Index data stale', IDX_BEFORE_10_00: 'Starts 10:00', IDX_BREADTH_UNAVAILABLE: 'No breadth data',
  IDX_BREADTH_SPLIT: 'Heavyweights split', IDX_FUTURES_OI_AGAINST: 'Futures OI against', IDX_NOT_HOLDING_VWAP: 'Not holding VWAP',
  IDX_NO_TRIGGER: 'Waiting for hold / base / wall break', IDX_RISK_TOO_WIDE: 'Risk too wide', IDX_LOCATION_NO_ROOM: 'OI wall too close', IDX_OI_UNAVAILABLE: 'Chain OI unavailable',
  IDX_FLOW_OPPOSED: 'Order flow against',
  MCX_NOT_A_COMMODITY: 'MCX only', MCX_BEFORE_START: 'Starts 45 min after open', MCX_FLOW_UNAVAILABLE: 'No order-flow data', MCX_FLOW_NOT_ALIGNED: 'Order flow not with the move',
  MCX_15M_AGAINST: '15m trend against', MCX_NOT_HOLDING_VWAP: 'Not holding VWAP', MCX_NO_TRIGGER: 'Waiting for bought hold / break', MCX_RISK_TOO_WIDE: 'Risk > 1.2 ATR',
  ORB_OUTSIDE_WINDOW: 'Opening range not formed', ORB_LATE_LEVEL_ALREADY_BROKEN: 'Range already broke earlier', ORB_REBREAK_NOT_BEYOND_TRAP: 'Re-break below trap high/low', ORB_NO_TREND: 'No 15m trend', ORB_RANGE_WIDTH: 'Opening range too narrow/wide', ORB_NO_BREAKOUT: 'No range breakout',
  ORB_BREAKOUT_QUALITY: 'Weak breakout bar', ORB_BREAKOUT_RVOL: 'Breakout volume low', ORB_NO_RETEST_TRIGGER: 'Waiting for retest',
  VWAP_BEFORE_10_30: 'Starts 10:30', VWAP_NO_TREND: 'No 15m trend', VWAP_NO_IMPULSE: 'No impulse leg', VWAP_PULLBACK_SHAPE: 'Pullback shape off',
  SWEEP_FIRST_30_MIN: 'First 30 min', SWEEP_LEVEL_NOT_BREACHED: 'PDH/PDL not swept', SWEEP_BREACH_NOT_RECENT: 'Sweep too old',
  OPEN_OUTSIDE_WINDOW: 'Outside opening window', OPEN_NO_TREND: 'No 15m trend', OPEN_IMPULSE_WEAK: 'Opening move weak', OPEN_PULLBACK_SHAPE: 'Pullback shape off', OPEN_NO_TRIGGER: 'Waiting for trigger',
  MOM_FIRST_30_MIN: 'First 30 min', MOM_LOW_EFFICIENCY: 'Move not directional', MOM_NO_NEW_EXTREME: 'No new day high/low', MOM_AGAINST_15M_EMA20: 'Against 15m EMA20', MOM_BAR_QUALITY: 'Weak breakout bar',
  FLAG_FIRST_45_MIN: 'First 45 min', FLAG_NO_STRONG_TREND: 'No strong trend', FLAG_NO_POLE: 'No flag pole', FLAG_SHAPE: 'Flag shape off', FLAG_NO_TRIGGER: 'Waiting for trigger',
  EVENT_NO_RECENT_RELEASE: 'No recent data release', VWAP_RANGE: 'Chopping around VWAP',
  RVOL_HISTORY_INSUFFICIENT: 'Volume history short', WARMUP: 'Warming up (history)', BLOCKED_REFERENCE_OR_CALENDAR: 'Live price stale', BLOCKED_EVENT_DATA: 'Event blackout',
  TREND_FIRST_15M_PENDING: 'First 15 min', STALE_TREND_CONTEXT: '15m bar missing', ENTRY_WINDOW: 'Entry window closed', MISSING_BARS: 'Bars missing', NO_VOLUME: 'No volume',
  TARGET_TOO_CLOSE: 'Target too close', SETUP_CONDITIONS_NOT_MET: 'No setup',
});

/** The reason a Radar cell shows: the furthest gate the setup reached when the engine gave one, else its code. */
export function radarReason(c: Pick<RadarCell, 'code' | 'detail'>): string {
  // A gate detail names the reason for "no setup" / "choppy"; for data codes (WARMUP, stale reference) the code does,
  // and the detail is only the measured input (hover).
  const gated = c.code === 'SETUP_CONDITIONS_NOT_MET' || c.code === 'CHOPPY_REGIME';
  const key = (gated ? c.detail : null) ?? c.code;
  if (!key) return '—';
  const choppy = /^EFFICIENCY_(\d)0PCT$/.exec(key);
  if (choppy) return `Choppy (trend ${choppy[1]}0%)`;
  return RADAR_REASONS[key] ?? key.replaceAll('_', ' ').toLowerCase();
}
export interface RadarRow { instrument: string; at: number | null; cells: Record<string, RadarCell> }

/**
 * Per instrument × strategy, today's latest state: an open trade, else the latest candidate decision, else the
 * latest evaluation's refusal code (e.g. no setup), else not evaluated today.
 */
export function setupRadar(status: FreshStartStatus | null, positions: PositionView[], now: number): RadarRow[] {
  if (!status) return [];
  const today = istDay(now);
  const rows = new Map<string, RadarRow>();
  const row = (instrument: string) => {
    let r = rows.get(instrument);
    if (!r) {
      r = { instrument, at: null, cells: Object.fromEntries(STRATEGY_IDS.map((s) => [s, { state: 'NOT_EVALUATED' as RadarState, code: null, at: null }])) };
      rows.set(instrument, r);
    }
    return r;
  };
  // Evaluations come newest first; the first seen per instrument is the latest.
  for (const e of status.evaluations ?? []) {
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || istDay(at) !== today) continue;
    const r = row(e.instrument);
    if (r.at != null) continue;
    r.at = at;
    for (const ref of Array.isArray(e.refusals) ? (e.refusals as Array<{ strategy?: string; code?: string; detail?: string | null }>) : []) {
      if (ref.strategy && r.cells[ref.strategy]) r.cells[ref.strategy] = { state: 'NO_SETUP', code: ref.code ?? null, at, detail: ref.detail ?? null };
    }
  }
  for (const c of [...status.candidates].reverse()) {
    const at = Date.parse(c.at);
    if (!Number.isFinite(at) || istDay(at) !== today) continue;
    const cand = obj(obj(c.evidence).candidate);
    const instrument = str(cand.instrument);
    if (!instrument) continue;
    const r = row(instrument);
    r.cells[c.strategy] = { state: c.decision === 'FILLED' ? 'FILLED' : 'REFUSED', code: c.code, at };
    r.at = Math.max(r.at ?? 0, at);
  }
  for (const p of positions) {
    if (p.status === 'CLOSED') continue;
    const r = rows.get(p.instrument) ?? [...rows.values()].find((x) => x.instrument.startsWith(p.instrument)) ?? row(p.instrument);
    r.cells[p.strategy] = { state: 'IN_TRADE', code: p.contract, at: p.openedAt };
  }
  return [...rows.values()].sort((a, b) => a.instrument.localeCompare(b.instrument));
}

// ---------------- Contract picker (mirrors the engine's admission checks) ----------------

export interface PickerCheck { rule: string; value: string; ok: boolean }
export interface PickerCandidate {
  strike: number;
  leg: OptionChainLeg;
  checks: PickerCheck[];
  eligible: boolean;
  firstFailure: string | null;
  spreadPct: number | null;
}
export interface PickerResult {
  side: 'CE' | 'PE';
  selected: PickerCandidate | null;
  rejected: PickerCandidate[];
  sizing: { riskBudget: number; emergencyStop: number; entry: number; lots: number; units: number } | null;
}

/**
 * Which contract the fresh-start engine's admission rules would accept on this chain (indicative only; the engine
 * also checks the modelled net payoff, exposure and account state, which the chain alone cannot):
 *   |delta| 0.45–0.65 on the trade's side · spread ≤ 1% of mid (1.5% for stock options) · two-sided book ·
 *   quote ≤ 2 s old · entry = ask + 1 tick · emergency stop 75% of entry · risk 0.5% of capital.
 */
export function pickContract(chain: OptionChain, side: 'CE' | 'PE', capital: number | null, now: number, opts: { stockOptions?: boolean; tick?: number } = {}): PickerResult {
  const tick = opts.tick ?? 0.05;
  const maxSpread = opts.stockOptions ? 0.015 : 0.01;
  const candidates: PickerCandidate[] = [];
  for (const s of chain.strikes) {
    const leg = side === 'CE' ? s.call : s.put;
    if (!leg) continue;
    const d = Math.abs(leg.delta);
    const mid = (leg.ask + leg.bid) / 2;
    const spreadPct = leg.bid > 0 && leg.ask > 0 && mid > 0 ? (leg.ask - leg.bid) / mid : null;
    const observed = leg.exchangeTimestamp ?? leg.timestamp;
    const age = Number.isFinite(observed) ? (now - observed) / 1000 : null;
    const sideOk = side === 'CE' ? leg.delta > 0 : leg.delta < 0;
    const checks: PickerCheck[] = [
      { rule: '|Delta| 0.45 – 0.65', value: Number.isFinite(leg.delta) ? leg.delta.toFixed(2) : '—', ok: sideOk && d >= 0.45 && d <= 0.65 },
      { rule: `Spread ≤ ${(maxSpread * 100).toFixed(1)}% of mid`, value: spreadPct == null ? '—' : `${(spreadPct * 100).toFixed(2)}%`, ok: spreadPct != null && spreadPct <= maxSpread },
      { rule: 'Two-sided book', value: leg.bid > 0 && leg.ask > 0 ? `${leg.bid.toFixed(2)} / ${leg.ask.toFixed(2)}` : 'one-sided', ok: leg.bid > 0 && leg.ask > 0 },
      { rule: 'Depth ≥ 1 lot both sides', value: leg.bidQty != null && leg.askQty != null ? `${leg.bidQty} / ${leg.askQty}` : 'not reported', ok: leg.bidQty != null && leg.askQty != null && Math.min(leg.bidQty, leg.askQty) >= chain.lotSize },
      { rule: 'Quote ≤ 2 s old at snapshot', value: age == null ? '—' : `${age.toFixed(1)} s`, ok: age != null && age >= 0 && age <= 2 },
    ];
    const failure = checks.find((c) => !c.ok);
    candidates.push({ strike: s.strike, leg, checks, eligible: !failure, firstFailure: failure ? failure.rule : null, spreadPct });
  }
  // Closest to the middle of the delta band wins, as the engine prefers the nearest-to-ATM eligible strike.
  const byDelta = (a: PickerCandidate, b: PickerCandidate) => Math.abs(Math.abs(a.leg.delta) - 0.55) - Math.abs(Math.abs(b.leg.delta) - 0.55);
  const eligible = candidates.filter((c) => c.eligible).sort(byDelta);
  const selected = eligible[0] ?? null;
  const near = candidates.filter((c) => !c.eligible && Math.abs(c.strike - chain.atmStrike) <= chain.strikeInterval * 3).sort((a, b) => Math.abs(a.strike - chain.atmStrike) - Math.abs(b.strike - chain.atmStrike));
  let sizing: PickerResult['sizing'] = null;
  if (selected && capital) {
    const entry = selected.leg.ask + tick;
    const emergencyStop = Math.ceil((entry * 0.75) / tick - 1e-9) * tick;
    const riskBudget = capital * RISK_FRACTION;
    const perLot = (entry - (emergencyStop - tick)) * chain.lotSize;
    const lots = perLot > 0 ? Math.max(0, Math.floor(Math.min(riskBudget / perLot, (0.05 * capital) / (entry * chain.lotSize)))) : 0;
    sizing = { riskBudget, emergencyStop, entry, lots, units: lots * chain.lotSize };
  }
  return { side, selected, rejected: near.slice(0, 4), sizing };
}

// ---------------- Formatting ----------------

export const inr = (v: number | null | undefined, digits = 0) =>
  v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : ''}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
export const signedInr = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${inr(v)}`);
export const signedR = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}R`);
export const istTime = (ms: number | null | undefined) =>
  ms == null ? '—' : new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
export const tone = (v: number | null | undefined): 'up' | 'down' | 'flat' => (v == null || v === 0 ? 'flat' : v > 0 ? 'up' : 'down');

/** Closed trades grouped by their order-flow shadow tag: does ALIGNED beat OPPOSED? (Shadow only: no trade was gated.) */
export const ORDER_FLOW_TAGS = ['ALIGNED', 'NEUTRAL', 'OPPOSED', 'UNAVAILABLE', 'UNTAGGED'] as const;
export function orderFlowShadow(positions: PositionView[]): Array<{ tag: string; trades: number; wins: number; winRate: number | null; avgR: number | null; net: number }> {
  return ORDER_FLOW_TAGS.map((tag) => {
    const closed = positions.filter((p) => p.status === 'CLOSED' && p.orderFlow === tag);
    const rs = closed.map((p) => p.r).filter((r): r is number => r != null);
    const wins = closed.filter((p) => (p.netPnl ?? 0) > 0).length;
    return { tag, trades: closed.length, wins, winRate: closed.length ? wins / closed.length : null, avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, net: closed.reduce((a, p) => a + (p.netPnl ?? 0), 0) };
  }).filter((x) => x.trades > 0 || x.tag !== 'UNTAGGED');
}
