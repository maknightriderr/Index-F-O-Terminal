// ============================================================
// DHAN ENGINE v2 — SHADOW RECORDER (phase 3)
// ============================================================
// After each 15-minute bar close, setups A–D are evaluated on every flow contract whose bar just closed, and the
// expiry-gamma module on each index option-chain sample. Evaluations whose setup conditions were met are written to
// dhan_engine_signals (SIGNAL, or NO_TRADE with its reasons); the rest are counted by their first failed condition
// and summarised in the log. SHADOW ONLY: nothing here opens a paper or real position (phase 4 decides that).
// Bounded work: one pass per closed bar, yielding between contracts; any failure is logged and skipped.
// ============================================================

import {
  evaluateDhanSetups, evaluateExpiryGamma, istSession, pivotR1, vwapFromSums,
  DHAN_GAMMA_ID, DHAN_GAMMA_VERSION, DHAN_SETUP_VERSION, type EngineBar, type FootprintBar, type GammaResult, type GammaSample, type SetupContext, type SetupResult,
} from '@fno/analytics';
import { getSessionWindow, type Exchange, type OptionChain } from '@fno/shared';
import { sql } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { flowContractBars, flowSessionState, flowSymbols } from './order-flow-store.js';

export const DHAN_SIGNALS_MIGRATION = '053_dhan_engine_signals.sql';
export const DHAN_PAPER_MIGRATION = '054_dhan_engine_paper.sql';

/** Phase 4: what a recorded SIGNAL is handed to (the fresh-start worker registers it); returns the paper decision. */
export interface DhanPaperRequest { symbol: string; result: SetupResult; barTime: number; decidedAt: number; atr: number; exchange: string; kind: SetupContext['kind']; gamma?: undefined }
/** Expiry gamma (8 Nov, 30% premium stop): the index, its signal and the chain sample time. */
export interface DhanGammaPaperRequest { symbol: string; gamma: GammaResult; at: number }
export type DhanPaperHandler = (r: DhanPaperRequest | DhanGammaPaperRequest) => Promise<{ decision: string; candidateId: string | null }>;
let paperHandler: DhanPaperHandler | null = null;
export function setDhanPaperHandler(h: DhanPaperHandler | null): void { paperHandler = h; }
/** RVOL compares only bars recorded under the v2 reconciler (deployed 7 Nov; first session 9 Nov). */
export const RVOL_SINCE = Date.parse('2026-11-09T00:00:00+05:30');
const SUMMARY_LOG_MS = 15 * 60_000;

export type Health = (symbol: string, now: number) => { stale: boolean; mappingValid: boolean };

const state = {
  evaluated: new Map<string, number>(),
  busy: false,
  failures: new Map<string, number>(),
  recorded: { SIGNAL: 0, NO_TRADE: 0 },
  summaryAt: 0,
  rvol: new Map<string, { day: string; bySlot: Map<string, number[]> }>(),
  gamma: new Map<string, { day: string; samples: GammaSample[]; fired: Set<string> }>(),
  paper: new Map<string, number>(),
  /** Radar (9 Nov): each contract's latest A-D outcome today (the side that got furthest, SIGNAL first). */
  latest: new Map<string, { at: number; day: string; setups: Record<string, { status: string; side: string | null; failed: string | null; passed: number; score: number | null }> }>(),
};

const traded = (f: FootprintBar) => f.deltaMode !== 'UNAVAILABLE' && f.high != null && f.low != null && f.close != null;
const slotOf = (t: number) => new Date(t + 19_800_000).toISOString().slice(11, 16);

/** Daily bars of the contract from its in-memory footprints of earlier sessions (oldest first). */
export function dailyFromFootprints(fps: readonly FootprintBar[], today: string): EngineBar[] {
  const days = new Map<string, EngineBar>();
  for (const f of fps) {
    if (!traded(f)) continue;
    const d = istSession(f.barTime);
    if (d >= today) continue;
    const x = days.get(d);
    if (!x) days.set(d, { time: f.barTime, open: f.open ?? f.close!, high: f.high!, low: f.low!, close: f.close! });
    else (x.high = Math.max(x.high, f.high!)), (x.low = Math.min(x.low, f.low!)), (x.close = f.close!);
  }
  return [...days.values()].sort((a, b) => a.time - b.time);
}

const shiftDay = (day: string, k: number) => istSession(Date.parse(`${day}T12:00:00+05:30`) + k * 86_400_000);
/** A day's bars cover its session: the first traded bar within 30 minutes of the open, the last within 30 of the close. */
function dayCovered(byDay: Map<string, number[]>, exchange: Exchange, day: string): boolean {
  const w = getSessionWindow(exchange, day), t = byDay.get(day);
  if (!w || !t?.length) return false;
  return Math.min(...t) <= w.open + 30 * 60_000 && Math.max(...t) + 15 * 60_000 >= w.close - 30 * 60_000;
}
/**
 * 8 Nov audit: PDH / PDL need the previous trading session (exchange calendar) fully in memory, PWH / PWL every trading
 * day of the previous ISO week; otherwise those levels would come from a partial day / week and are dropped.
 */
export function referenceCompleteness(fps: readonly FootprintBar[], exchange: Exchange, today: string): { previousDay: boolean; previousWeek: boolean } {
  const byDay = new Map<string, number[]>();
  for (const f of fps) if (traded(f)) { const d = istSession(f.barTime); byDay.set(d, [...(byDay.get(d) ?? []), f.barTime]); }
  let prev: string | null = null;
  for (let k = 1; k <= 10 && !prev; k++) { const d = shiftDay(today, -k); if (getSessionWindow(exchange, d)) prev = d; }
  const weekday = (new Date(`${today}T12:00:00+05:30`).getUTCDay() + 6) % 7; // Monday = 0
  const lastWeek = Array.from({ length: 7 }, (_, k) => shiftDay(today, -weekday - 7 + k)).filter((d) => getSessionWindow(exchange, d));
  return { previousDay: prev != null && dayCovered(byDay, exchange, prev), previousWeek: lastWeek.length > 0 && lastWeek.every((d) => dayCovered(byDay, exchange, d)) };
}

/** Same-slot traded volume of up to 20 earlier sessions (order_flow_bars since RVOL_SINCE), cached per symbol per day. */
async function rvolReferences(symbol: string, today: string, now: number): Promise<Map<string, number[]>> {
  const c = state.rvol.get(symbol);
  if (c && c.day === today) return c.bySlot;
  const bySlot = new Map<string, number[]>();
  try {
    const rows = await sql<Array<{ bar_time: Date; volume: string | null }>>`
      SELECT bar_time, volume FROM order_flow_bars
      WHERE symbol = ${symbol} AND bar_time >= ${new Date(Math.max(RVOL_SINCE, now - 45 * 86_400_000))} AND bar_time < ${new Date(now - 12 * 3_600_000)} AND delta_mode <> 'UNAVAILABLE' AND volume IS NOT NULL
      ORDER BY bar_time`;
    for (const r of rows) {
      const t = new Date(r.bar_time).getTime();
      if (istSession(t) >= today) continue;
      const s = slotOf(t);
      bySlot.set(s, [...(bySlot.get(s) ?? []), Number(r.volume)]);
    }
  } catch (err: any) {
    logger.warn({ symbol, error: err.message }, 'Dhan engine shadow: RVOL references unavailable');
  }
  state.rvol.set(symbol, { day: today, bySlot });
  return bySlot;
}

const rvolOf = (refs: Map<string, number[]>, f: FootprintBar): number | null => {
  const r = (refs.get(slotOf(f.barTime)) ?? []).slice(-20);
  const mean = r.reduce((a, x) => a + x, 0) / Math.max(1, r.length);
  return r.length >= 20 && mean > 0 && f.volume != null ? Math.round((f.volume / mean) * 10000) / 10000 : null;
};

/** The setups context of one contract from the flow store, or null when it has no closed traded bar today. */
export async function setupContextFor(symbol: string, now: number, health: Health, withRvol = true): Promise<SetupContext | null> {
  const st = flowContractBars(symbol);
  if (!st || !st.tickSize) return null;
  const fps = st.footprints.filter(traded);
  if (!fps.length) return null;
  const today = istSession(fps[fps.length - 1].barTime);
  if (today !== istSession(now)) return null;
  const refs = withRvol && schemaFileReady('038_order_blocks_order_flow_of1.sql') ? await rvolReferences(symbol, today, now) : new Map<string, number[]>();
  const firstToday = fps.find((f) => istSession(f.barTime) === today)!;
  // The exchange's session open (not the first traded bar: after a gap the opening range must not move), and the
  // first lost bar of today's session (a restart gap / unreconciled-only bar): session running totals end there.
  const sessionOpen = getSessionWindow(st.exchange as Exchange, today)?.open ?? firstToday.barTime;
  const gapAt = st.footprints.find((f) => istSession(f.barTime) === today && f.incomplete && f.deltaMode === 'UNAVAILABLE')?.barTime ?? null;
  const bars: EngineBar[] = fps.map((f, k) => ({ time: f.barTime, open: f.open ?? fps[k - 1]?.close ?? f.close!, high: f.high!, low: f.low!, close: f.close!, volume: f.volume ?? 0 }));
  return {
    symbol, instrument: st.instrument, kind: st.kind, exchange: st.exchange, tickSize: st.tickSize, bars, fps,
    vwapSums: fps.map((f) => f.tradeSums ?? null), rvol: fps.map((f) => rvolOf(refs, f)), daily: dailyFromFootprints(st.footprints, today),
    sessionOpen, referenceComplete: referenceCompleteness(st.footprints, st.exchange as Exchange, today), health: { ...health(symbol, now), sessionGapAt: gapAt },
  };
}

async function record(symbol: string, ctx: SetupContext, barTime: number, window: string, regime: string | null, r: SetupResult): Promise<void> {
  if (!schemaFileReady(DHAN_SIGNALS_MIGRATION)) return;
  await sql`
    INSERT INTO dhan_engine_signals (strategy, side, symbol, instrument, exchange, bar_time, status, score, eligibility, entry, stop_loss, target, rr, session_window, regime, checks, gates, no_trade, evidence, version)
    VALUES (${r.strategy}, ${r.side}, ${symbol}, ${ctx.instrument}, ${ctx.exchange}, ${new Date(barTime)}, ${r.status}, ${r.score?.total ?? null}, ${r.score?.eligibility ?? null},
      ${r.plan?.entry ?? null}, ${r.plan?.sl ?? null}, ${r.plan?.target ?? null}, ${r.plan?.rr ?? null}, ${window}, ${regime},
      ${sql.json(r.checks as any)}, ${sql.json(r.gates as any)}, ${sql.json(r.noTrade as any)}, ${sql.json({ ...r.evidence, score: r.score?.lines ?? null, targetKind: r.plan?.targetKind ?? null } as any)}, ${DHAN_SETUP_VERSION})
    ON CONFLICT (strategy, side, symbol, bar_time) DO NOTHING`;
}

async function paper(h: DhanPaperHandler, req: DhanPaperRequest | DhanGammaPaperRequest): Promise<void> {
  let out: { decision: string; candidateId: string | null };
  try { out = await h(req); } catch (err: any) { out = { decision: err instanceof Error && /^[A-Z_]+$/.test(err.message) ? err.message : 'PAPER_PATH_FAILED', candidateId: null }; }
  state.paper.set(out.decision, (state.paper.get(out.decision) ?? 0) + 1);
  const strategy = req.gamma ? DHAN_GAMMA_ID : req.result.strategy, side = req.gamma ? req.gamma.side : req.result.side;
  const barTime = req.gamma ? Math.floor(req.at / 60_000) * 60_000 : req.barTime;
  logger.info({ event: 'dhanPaperDecision', symbol: req.symbol, strategy, side, decision: out.decision, candidateId: out.candidateId }, 'Dhan engine: paper decision for a setup signal (options, paper only)');
  if (!schemaFileReady(DHAN_PAPER_MIGRATION)) return;
  await sql`UPDATE dhan_engine_signals SET paper_decision = ${out.decision}, paper_candidate_id = ${out.candidateId}
            WHERE strategy = ${strategy} AND side = ${side} AND symbol = ${req.symbol} AND bar_time = ${new Date(barTime)}`
    .catch((err: any) => logger.warn({ symbol: req.symbol, error: err.message }, 'Dhan engine: paper decision write failed'));
}

const RANK: Record<string, number> = { SIGNAL: 3, NO_TRADE: 2, NO_SETUP: 1 };
/** Per setup, the outcome of the side that got furthest (SIGNAL > NO_TRADE > most conditions passed). */
export function radarOf(results: readonly SetupResult[]): Record<string, { status: string; side: string | null; failed: string | null; passed: number; score: number | null }> {
  const out: Record<string, { status: string; side: string | null; failed: string | null; passed: number; score: number | null }> = {};
  for (const r of results) {
    const passed = r.checks.filter((c) => c.ok).length, cur = out[r.setup];
    const better = !cur || RANK[r.status] > RANK[cur.status] || (RANK[r.status] === RANK[cur.status] && passed > cur.passed);
    if (better) out[r.setup] = { status: r.status, side: r.status === 'NO_SETUP' ? null : r.side, failed: r.failed ?? (r.status === 'NO_TRADE' ? [...r.gates.filter((g) => !g.ok).map((g) => g.id), ...(r.noTrade?.reasons ?? [])][0] ?? `SCORE_${r.score?.total ?? 0}` : null), passed, score: r.score?.total ?? null };
  }
  return out;
}

/** True while a shadow pass runs (a bar closed meanwhile is picked up by the next pass). */
export const dhanShadowBusy = () => state.busy;

/** Evaluate every contract whose latest bar closed since its last evaluation. Returns the number evaluated. */
export async function evaluateDhanShadow(now: number, health: Health): Promise<number> {
  if (state.busy) return 0;
  state.busy = true;
  let n = 0;
  try {
    for (const symbol of flowSymbols()) {
      const st = flowContractBars(symbol);
      const last = st?.footprints.at(-1)?.barTime;
      if (last == null || state.evaluated.get(symbol) === last) continue;
      state.evaluated.set(symbol, last);
      try {
        const ctx = await setupContextFor(symbol, now, health);
        if (!ctx || ctx.bars.at(-1)!.time !== last) continue; // the newest closed bar had no trades: nothing to decide on
        const ev = evaluateDhanSetups(ctx);
        n++;
        state.latest.set(symbol, { at: last, day: istSession(last), setups: radarOf(ev.results) });
        for (const r of ev.results) {
          if (r.status === 'NO_SETUP') { const k = `${r.strategy}:${r.failed}`; state.failures.set(k, (state.failures.get(k) ?? 0) + 1); continue; }
          state.recorded[r.status]++;
          if (r.status === 'SIGNAL') logger.info({ event: 'dhanShadowSignal', symbol, strategy: r.strategy, side: r.side, barTime: new Date(last).toISOString(), score: r.score?.total, plan: r.plan, window: ev.sessionWindow }, 'Dhan engine shadow signal (recorded only, no position)');
          await record(symbol, ctx, last, ev.sessionWindow, ev.regime?.regime ?? null, r).catch((err: any) => logger.warn({ symbol, strategy: r.strategy, error: err.message }, 'Dhan engine shadow: signal write failed'));
          if (r.status === 'SIGNAL' && paperHandler) void paper(paperHandler, { symbol, result: r, barTime: last, decidedAt: last + 15 * 60_000, atr: Number(r.evidence.atr) || 0, exchange: ctx.exchange, kind: ctx.kind });
        }
      } catch (err: any) {
        logger.warn({ symbol, error: err.message }, 'Dhan engine shadow: evaluation failed');
      }
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    state.busy = false;
  }
  if (now - state.summaryAt >= SUMMARY_LOG_MS && (n > 0 || state.failures.size)) {
    state.summaryAt = now;
    const top = [...state.failures].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, c]) => ({ k, c }));
    logger.info({ event: 'dhanShadowSummary', evaluated: n, recorded: state.recorded, firstFailures: top }, 'Dhan engine shadow: setups A-D summary (shadow only)');
  }
  return n;
}

// ---------------- expiry gamma ----------------

/** True when the chain's expiry is the IST trading day of `now` (accepts ISO dates and anything Date.parse reads). */
export function chainExpiresToday(expiry: string | null | undefined, now: number): boolean {
  if (!expiry) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(expiry)) return expiry.slice(0, 10) === istSession(now);
  const t = Date.parse(expiry);
  return Number.isFinite(t) && istSession(t) === istSession(now);
}

/**
 * One option-chain sample of an index (from the fresh-start worker's chain refresh). Keeps today's samples (ATM ± 5
 * strikes) and, on expiry day inside the module's window, evaluates and records each side's first signal of the day.
 * The day's spot high / low come from today's earlier samples (about one a minute; labelled CHAIN_SAMPLE_SPOT). R1
 * needs the previous day's spot high / low / close, which this path does not hold, so it is null (the rule's "day high
 * or R1" then reads the day high only).
 */
export async function recordGammaChain(index: string, chain: Pick<OptionChain, 'spotPrice' | 'expiry' | 'strikes'>, at: number, now: number = Date.now(), previousDay: { high: number; low: number; close: number } | null = null): Promise<void> {
  try {
    if (!(chain.spotPrice > 0) || !chain.strikes.length) return;
    const day = istSession(at);
    let g = state.gamma.get(index);
    // The day's samples (the 11:30-13:15 baseline, the day high / low) and fired sides survive a restart in Redis.
    if (!g || g.day !== day) state.gamma.set(index, (g = await loadGamma(index, day)));
    const sorted = [...chain.strikes].sort((a, b) => a.strike - b.strike);
    const atmIdx = sorted.reduce((bi, s, k) => (Math.abs(s.strike - chain.spotPrice) < Math.abs(sorted[bi].strike - chain.spotPrice) ? k : bi), 0);
    const near = sorted.slice(Math.max(0, atmIdx - 5), atmIdx + 6).map((s) => ({ strike: s.strike, callOi: s.call?.oi ?? 0, putOi: s.put?.oi ?? 0 }));
    g.samples = [...g.samples.filter((s) => s.at !== at), { at, spot: chain.spotPrice, strikes: near }].slice(-400);
    saveGamma(index, g);
    if (!chainExpiresToday(chain.expiry, now)) return;
    const steps = near.slice(1).map((s, k) => s.strike - near[k].strike).filter((d) => d > 0);
    const strikeStep = steps.length ? Math.min(...steps) : 0;
    if (!(strikeStep > 0)) return;
    const earlier = g.samples.filter((x) => x.at < at).map((x) => x.spot);
    const fut = flowSessionState(index, now);
    const fv = fut?.vwap ? vwapFromSums(fut.vwap.sums, 'TRADES', fut.vwap.unreconciled) : null;
    const lastFp = fut?.footprints.at(-1);
    const results = evaluateExpiryGamma({
      index, expiryToday: true, now, samples: g.samples, strikeStep,
      dayHigh: earlier.length ? Math.max(...earlier) : null, dayLow: earlier.length ? Math.min(...earlier) : null,
      r1: pivotR1(previousDay), futuresPrice: lastFp?.close ?? null, futuresVwap: fv?.status === 'ESTIMATED' ? fv.vwap : null,
    });
    for (const r of results) {
      if (r.status !== 'SIGNAL' || g.fired.has(r.side)) continue;
      g.fired.add(r.side);
      saveGamma(index, g);
      logger.info({ event: 'dhanShadowSignal', symbol: index, strategy: DHAN_GAMMA_ID, side: r.side, strikes: r.strikes, evidence: r.evidence }, 'Dhan engine signal (paper decision follows)');
      if (schemaFileReady(DHAN_SIGNALS_MIGRATION)) await sql`
        INSERT INTO dhan_engine_signals (strategy, side, symbol, instrument, exchange, bar_time, status, entry, session_window, checks, evidence, version)
        VALUES (${DHAN_GAMMA_ID}, ${r.side}, ${index}, ${null}, ${null}, ${new Date(Math.floor(at / 60_000) * 60_000)}, ${'SIGNAL'}, ${chain.spotPrice}, ${'EXPIRY_PM'},
          ${sql.json(r.checks as any)}, ${sql.json({ ...r.evidence, dayRangeSource: 'CHAIN_SAMPLE_SPOT', strikes: r.strikes, forcedExitAt: r.forcedExitAt } as any)}, ${DHAN_GAMMA_VERSION})
        ON CONFLICT (strategy, side, symbol, bar_time) DO NOTHING`.catch((err: any) => logger.warn({ index, error: err.message }, 'Dhan engine shadow: gamma write failed'));
      if (paperHandler) void paper(paperHandler, { symbol: index, gamma: r, at });
    }
  } catch (err: any) {
    logger.warn({ index, error: err.message }, 'Dhan engine shadow: gamma evaluation failed');
  }
}

const gammaKey = (index: string, day: string) => `dhan:gamma:${index}:${day}`;
async function loadGamma(index: string, day: string): Promise<{ day: string; samples: GammaSample[]; fired: Set<string> }> {
  try {
    const raw = await redis.get(gammaKey(index, day));
    const x = raw ? JSON.parse(raw) : null;
    if (x && Array.isArray(x.samples)) return { day, samples: x.samples.filter((s: GammaSample) => s && Number.isFinite(s.at) && s.spot > 0 && Array.isArray(s.strikes)).slice(-400), fired: new Set(Array.isArray(x.fired) ? x.fired : []) };
  } catch { /* no saved samples: start the day empty */ }
  return { day, samples: [], fired: new Set() };
}
function saveGamma(index: string, g: { day: string; samples: GammaSample[]; fired: Set<string> }): void {
  try { void redis.set(gammaKey(index, g.day), JSON.stringify({ samples: g.samples, fired: [...g.fired] }), 'EX', 2 * 86_400).catch(() => undefined); } catch { /* best effort */ }
}

/** Recorded shadow signals of an IST day (diagnostics). */
export async function dhanShadowSignals(day: string): Promise<unknown[]> {
  if (!schemaFileReady(DHAN_SIGNALS_MIGRATION)) return [];
  const from = new Date(`${day}T00:00:00+05:30`), to = new Date(from.getTime() + 86_400_000);
  const rows = await sql<Array<Record<string, unknown>>>`SELECT *
             FROM dhan_engine_signals WHERE bar_time >= ${from} AND bar_time < ${to} ORDER BY bar_time, symbol, strategy LIMIT 500`;
  return [...rows];
}

export function dhanShadowStatus() {
  const today = istSession(Date.now());
  return { recorded: { ...state.recorded }, paper: Object.fromEntries(state.paper), latest: Object.fromEntries([...state.latest].filter(([, v]) => v.day === today)), contracts: state.evaluated.size, firstFailures: [...state.failures].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, c]) => ({ k, c })), gamma: [...state.gamma].map(([index, g]) => ({ index, day: g.day, samples: g.samples.length, fired: [...g.fired] })) };
}

/** Tests only. */
export function resetDhanShadow(): void {
  state.evaluated.clear(); state.failures.clear(); state.rvol.clear(); state.gamma.clear(); state.paper.clear(); state.latest.clear();
  state.recorded = { SIGNAL: 0, NO_TRADE: 0 }; state.summaryAt = 0; state.busy = false;
}

