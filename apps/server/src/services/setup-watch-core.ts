// ============================================================
// CONFIRMED-SETUP WATCH (pure core) — display and lifecycle only
// ============================================================
// Every CONFIRMED setup (S1 sweep → displacement → zone; a trigger family's
// rule hit with a valid stop and target; the indicator engine's read that
// reached the option build) is shown under its SAME id, parent and trigger,
// and re-measured on every closed 15m bar with the existing setup logic:
//
//   Confirmed — R:R 1.20R        rrBand '1.0-1.5'
//   Confirmed — R:R 1.70R        rrBand '>=1.5'
//
// Net R:R is DISPLAY / RANKING ONLY (2026-10-05): it never moves a setup out
// of CONFIRMED, never hides it and never stops it reaching the paper-trade
// slot. 1.50R is a displayed reference (the rrBand edges), nothing else. The
// watch tracks only how a setup ENDS: INVALIDATION (stop traded, sweep
// reclaimed, a close beyond the rule's invalidation, T1 traded before a fill),
// EXPIRY (the fill window, the closing guard, session end) or FILLED (it became
// the paper trade).
//
// Every update is recorded against the same id (setup_events, decision
// LIFECYCLE — kept out of the census and the grading): started, re-evaluated,
// strike changes, option-build failures, ended. Decision-time data only:
// closed bars up to the evaluated bar and the live chain at that moment.
// ============================================================

import type { OptionTradePlan, RrBand, SetupWatchRow, SetupWatchSnapshot } from '@fno/shared';
import { MIN_RISK_REWARD, MAX_RISK_REWARD } from '@fno/analytics';
import type { LiveLifecycle } from './structure-live.js';

/** The displayed reference R:R (MIN_RISK_REWARD, a protected constant) — an rrBand edge, never a gate. */
export const RR_REFERENCE: number = MIN_RISK_REWARD;

/** Display-only R:R band: < 1.0, 1.0 – 1.5, ≥ 1.5 (null = not measured). Never read by a decision. */
export function rrBandOf(rr: number | null | undefined): RrBand | null {
  if (rr == null || !Number.isFinite(rr)) return null;
  return rr < 1 ? '<1.0' : rr < RR_REFERENCE ? '1.0-1.5' : '>=1.5';
}

/** The status line: always "Confirmed — R:R x" (R:R is shown, never compared against a threshold here). */
export function rrStatus(rr: number | null): { text: string; band: RrBand | null } {
  if (rr == null || !Number.isFinite(rr)) return { text: 'Confirmed — R:R not measured', band: null };
  return { text: `Confirmed — R:R ${rr.toFixed(2)}R`, band: rrBandOf(rr) };
}

/**
 * A stored naked long's R:R is plausible when it is positive (target above
 * entry, stop below it — genuine geometry) and not above MAX_RISK_REWARD (the
 * bad-upstream-data ceiling). No minimum R:R: since 2026-10-05 a 1.20R trade
 * is a valid trade and must not be retired on the next read.
 */
export function isNakedLongRiskRewardPlausible(riskReward: number | null | undefined): boolean {
  return riskReward != null && Number.isFinite(riskReward) && riskReward > 0 && riskReward <= MAX_RISK_REWARD;
}

/** The binding R:R: the lower of the measured ones (null when none is measured). */
export function bindingRR(...values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? Math.min(...v) : null;
}

// ---------------- S1: how a shown setup ends ----------------

export interface ClosedBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * S1's achievable fill on a closed bar: the zone limit, or the bar's close
 * when price already sits inside the zone (where a fill would happen now).
 */
export function structureReference(lc: Pick<LiveLifecycle, 'direction' | 'entry' | 'zone' | 'stop'>, close: number): number | null {
  if (lc.entry == null) return null;
  const bear = lc.direction === 'BEARISH';
  const near = lc.entry;
  const far = lc.zone?.far ?? near;
  const outer = bear ? Math.max(near, far) : Math.min(near, far);
  const inside = bear ? close >= near && close <= outer : close <= near && close >= outer;
  return inside ? close : near;
}

/** Gross R:R to T1 from an underlying reference, with the setup's own stop (display / ranking only). */
export function grossRRFrom(lc: Pick<LiveLifecycle, 'stop' | 't1'>, reference: number | null): number | null {
  if (reference == null || lc.stop == null || lc.t1 == null) return null;
  const risk = Math.abs(reference - lc.stop);
  const reward = Math.abs(lc.t1.price - reference);
  return risk > 0 ? Math.round((reward / risk) * 100) / 100 : null;
}

/**
 * Has a SHOWN S1 setup ended — by S1's own genuine rules only? Walks the
 * closed bars since it was confirmed (bars ≤ the newest closed bar): the stop
 * traded (STOP_TRADED), a close beyond the sweep extreme (SWEEP_RECLAIMED),
 * T1 traded before a fill (MISSED), or the fill window over (NO_FILL — the
 * engine's fillWithinBars). Net R:R and any paper-trade-log refusal never end
 * it. Null = still confirmed (or never confirmed). Pure, stateless.
 */
export function structureDisplayEnd(
  lc: Pick<LiveLifecycle, 'stage' | 'stageAt' | 'confirmedAt' | 'direction' | 'entry' | 'zone' | 'stop' | 't1' | 'sweepExtreme'>,
  closedBars: readonly ClosedBar[],
  barMs: number,
  fillWithinBars: number
): { reason: string; at: number } | null {
  const since = lc.confirmedAt ?? (lc.stage === 'LOW_RR' ? lc.stageAt : null);
  if (since == null || lc.stop == null || lc.t1 == null || lc.entry == null) return null;
  const bear = lc.direction === 'BEARISH';
  const after = closedBars.filter((b) => b.time + barMs > since);
  for (const [k, b] of after.entries()) {
    const at = b.time + barMs;
    if (bear ? b.high >= lc.stop : b.low <= lc.stop) return { reason: 'STOP_TRADED', at };
    if (bear ? b.close > lc.sweepExtreme : b.close < lc.sweepExtreme) return { reason: 'SWEEP_RECLAIMED', at };
    if (bear ? b.low <= lc.t1.price : b.high >= lc.t1.price) return { reason: 'MISSED', at };
    if (k + 1 > fillWithinBars) return { reason: 'NO_FILL', at };
  }
  return null;
}

/**
 * A confirmed S1 setup that is shown: it reached CONFIRMED (any R:R) with a
 * stop and a T1. (LOW_RR is kept for lifecycles recorded before 2026-10-05,
 * when 1.5R still decided confirmation.)
 */
export function isShownStructureSetup(lc: Pick<LiveLifecycle, 'stage' | 'confirmedAt' | 'entry' | 'stop' | 't1'>): boolean {
  if (lc.entry == null || lc.stop == null || lc.t1 == null) return false;
  return lc.confirmedAt != null || lc.stage === 'LOW_RR';
}

// ---------------- the per-setup lifecycle record ----------------

export type WatchEventType = 'WATCH_STARTED' | 'REEVALUATED' | 'STRIKE_CHANGED' | 'OPTION_BUILD_FAILED' | 'WATCH_ENDED';

export interface WatchUpdate {
  id: string;
  source: string;
  direction: 'BULLISH' | 'BEARISH';
  parentId: string | null;
  /** Decision time of this evaluation (the evaluated bar's close, or the check time for the indicator's cadence). */
  at: number;
  /** The closed bar (open time) this evaluation read up to. */
  barTime: number | null;
  /** The binding R:R this evaluation measured (display / ranking only). */
  statusRR: number | null;
  grossRR: number | null;
  netRR: number | null;
  /** Informational: the first genuine check that would stop the paper-trade log now (null = none). Never hides or ends the setup. */
  block: { code: string | null; reason: string } | null;
  plan: OptionTradePlan | null;
  /** True when the option leg itself could not be built (every strike failed a genuine check). */
  optionBuildFailed: boolean;
  underlying: { entry: number | null; sl: number | null; t1: number | null; t2: number | null };
  expiresAt: number | null;
  /** Set when this evaluation ends the setup: INVALIDATION, EXPIRY or FILLED. */
  ended?: { reason: string; at: number } | null;
}

function snapshotOf(u: WatchUpdate): SetupWatchSnapshot {
  return {
    at: u.at,
    underlyingEntry: u.underlying.entry,
    underlyingSl: u.underlying.sl,
    underlyingT1: u.underlying.t1,
    underlyingT2: u.underlying.t2,
    side: u.plan?.side ?? null,
    strike: u.plan?.strike ?? null,
    expiry: u.plan?.expiry ?? null,
    entryPremium: u.plan?.entryPremium ?? null,
    grossRR: u.grossRR,
    netRR: u.netRR,
    statusRR: u.statusRR,
  };
}

/**
 * Apply one evaluation to a setup's record — same id, never a second row —
 * and list what happened. Pure. An ended record is never reopened. Net R:R
 * only changes the displayed text and band, never the status.
 */
export function applyWatchUpdate(prev: SetupWatchRow | null, u: WatchUpdate): { row: SetupWatchRow; events: WatchEventType[] } {
  if (prev?.ended) return { row: prev, events: [] };
  const { text, band } = rrStatus(u.statusRR);
  const events: WatchEventType[] = [];
  if (!prev) events.push('WATCH_STARTED');
  else if (u.barTime !== prev.lastBarTime) events.push('REEVALUATED');
  const strikeChanged = prev?.plan != null && u.plan != null && (prev.plan.strike !== u.plan.strike || prev.plan.expiry !== u.plan.expiry || prev.plan.side !== u.plan.side);
  if (strikeChanged) events.push('STRIKE_CHANGED');
  if (u.optionBuildFailed) events.push('OPTION_BUILD_FAILED');
  if (u.ended) events.push('WATCH_ENDED');
  const snap = snapshotOf(u);
  const row: SetupWatchRow = {
    id: u.id,
    source: u.source,
    direction: u.direction,
    parentId: u.parentId,
    status: u.ended ? 'ENDED' : 'CONFIRMED',
    statusText: u.ended ? `Ended — ${u.ended.reason} (last: ${text})` : text,
    statusRR: u.statusRR,
    rrBand: band,
    blockCode: u.block?.code ?? null,
    blockReason: u.block?.reason ?? null,
    plan: u.plan ?? prev?.plan ?? null,
    initial: prev?.initial ?? snap,
    current: snap,
    strikeChanges: (prev?.strikeChanges ?? 0) + (strikeChanged ? 1 : 0),
    optionBuildFailures: (prev?.optionBuildFailures ?? 0) + (u.optionBuildFailed ? 1 : 0),
    startedAt: prev?.startedAt ?? u.at,
    updatedAt: u.at,
    lastBarTime: u.barTime,
    expiresAt: u.expiresAt,
    ended: u.ended ?? null,
  };
  return { row, events };
}

/** An update that only ends a row (INVALIDATION / EXPIRY / FILLED, or the indicator's bias flip), carrying its last measurements. Pure. */
export function endUpdateFor(row: SetupWatchRow, reason: string, at: number): WatchUpdate {
  return {
    id: row.id,
    source: row.source,
    direction: row.direction,
    parentId: row.parentId,
    at,
    barTime: row.lastBarTime,
    statusRR: row.statusRR,
    grossRR: row.current.grossRR,
    netRR: row.current.netRR,
    block: null,
    plan: row.plan,
    optionBuildFailed: false,
    underlying: { entry: row.current.underlyingEntry, sl: row.current.underlyingSl, t1: row.current.underlyingT1, t2: row.current.underlyingT2 },
    expiresAt: row.expiresAt,
    ended: { reason, at },
  };
}

// ---------------- the option plan in premium terms ----------------

/**
 * The displayed option plan from option levels the existing builder produced
 * (an available setup, or an R:R refusal's `rrPlan`). Premiums are projected
 * from the live mid to the underlying entry reference with the leg's delta —
 * the same projection the structure preview uses — and SL / targets keep the
 * builder's premium gaps. The TSL is the existing trailing rule (SL → entry at
 * +breakevenAtR, locks +1R at +lockAtR) in this contract's premium; before
 * entry the current TSL is the initial SL. Pure.
 */
export function planFromLevels(a: {
  side: 'CE' | 'PE';
  strike: number;
  expiry: string;
  dte: number | null;
  lotSize: number | null;
  levels: { entry: number; stopLoss: number; target: number };
  /** The leg's delta (sign ignored); null = premiums are not projected. */
  delta: number | null;
  spot: number;
  /** The underlying entry reference the premiums are projected to. */
  reference: number;
  /** A second build on the same strike for the T2 move (its entry and target), when the setup has a T2. */
  t2Levels?: { entry: number; target: number } | null;
  underlying: { sl: number | null; t1: number | null; t2: number | null };
  grossRR: number | null;
  netRR: number | null;
  estimatedCostPct: number | null;
  ranking: OptionTradePlan['strikeRanking'];
  trail: { breakevenAtR: number; lockAtR: number };
}): OptionTradePlan {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const absD = a.delta != null && Number.isFinite(a.delta) ? Math.abs(a.delta) : null;
  const shift = absD != null ? (a.side === 'CE' ? absD : -absD) * (a.reference - a.spot) : 0;
  const estimated = absD != null && Math.abs(a.reference - a.spot) > 0.005;
  const entryPremium = r2(Math.max(0.05, a.levels.entry + shift));
  const slPremium = r2(Math.max(0.05, entryPremium - (a.levels.entry - a.levels.stopLoss)));
  const t1Premium = r2(Math.max(slPremium + 0.05, entryPremium + (a.levels.target - a.levels.entry)));
  const t2Premium = a.t2Levels ? r2(Math.max(t1Premium, entryPremium + (a.t2Levels.target - a.t2Levels.entry))) : null;
  const risk = entryPremium - slPremium;
  const be = r2(entryPremium + a.trail.breakevenAtR * risk);
  const lockTrigger = r2(entryPremium + a.trail.lockAtR * risk);
  const lockLevel = r2(entryPremium + risk);
  return {
    side: a.side,
    strike: a.strike,
    expiry: a.expiry,
    dte: a.dte,
    lotSize: a.lotSize,
    entryPremium,
    slPremium,
    tslPremium: slPremium,
    tslRule: `TSL = SL ₹${slPremium.toFixed(2)} until entry; then at +${a.trail.breakevenAtR}R (premium ₹${be.toFixed(2)}) SL → entry ₹${entryPremium.toFixed(2)}; at +${a.trail.lockAtR}R (₹${lockTrigger.toFixed(2)}) SL → ₹${lockLevel.toFixed(2)} (locks +1R).`,
    t1Premium,
    t2Premium,
    underlyingEntry: r2(a.reference),
    underlyingSl: a.underlying.sl,
    underlyingT1: a.underlying.t1,
    underlyingT2: a.underlying.t2,
    grossRR: a.grossRR,
    netRR: a.netRR,
    estimatedCostPct: a.estimatedCostPct,
    estimated,
    strikeRanking: a.ranking,
  };
}

