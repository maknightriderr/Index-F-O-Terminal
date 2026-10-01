// ============================================================
// CONFIRMED-SETUP WATCH (pure core) — a confirmed setup is not forgotten for R:R alone
// ============================================================
// A setup that is CONFIRMED (S1 sweep → displacement → zone; a trigger
// family's rule hit with a valid stop and target; the indicator engine's
// directional read) but whose R:R is below 1.50R is kept ALIVE under its SAME
// id, parent and trigger, re-measured on every closed 15m bar with the
// existing setup logic, and shown with its full option plan:
//
//   Confirmed — R:R 1.40R < 1.50R
//   Eligible — R:R 1.62R ≥ 1.50R
//   Blocked — R:R 1.62R ≥ 1.50R · COST_TOO_HIGH: …   (another hard check)
//
// The 1.50R minimum is unchanged and nothing here trades: a kept-alive setup
// reaches the paper slot only through its engine's own chain, with every hard
// check, when it is eligible on a closed bar. It still ends on its engine's
// invalidation (sweep reclaimed, stop or T1 traded, a close beyond the rule's
// invalidation) or expiry (the fill window, the closing guard, session end).
//
// Every update is recorded against the same id (setup_events, decision
// LIFECYCLE — kept out of the census and the grading): started, re-evaluated,
// RR_RECOVERED, strike changes, option-build failures, ended. Decision-time
// data only: closed bars up to the evaluated bar and the live chain at that
// moment; nothing after it.
// ============================================================

import type { OptionTradePlan, SetupWatchRow, SetupWatchSnapshot } from '@fno/shared';
import { STRUCTURE_RULES } from '@fno/analytics';
import type { LiveLifecycle } from './structure-live.js';

/** The minimum R:R — the existing one (structure minT1R = the builder's MIN_RISK_REWARD = 1.5), not a new threshold. */
export const RR_MIN: number = STRUCTURE_RULES.minT1R;

/** Floor to 2 dp, so a value below the minimum never prints as "1.50R < 1.50R". */
const floor2 = (n: number) => Math.floor(n * 100 + 1e-9) / 100;

/**
 * The status line. R:R is INFORMATIONAL for a shown setup (user decision
 * 2026-10-02): every confirmed setup reads "Confirmed", and 1.50R is only the
 * reference it is compared against — never a reason to hide, reject or end
 * it. `rr` is the BINDING R:R (the lower of the underlying R:R to T1, where
 * the engine has one, and the option's net R:R after costs). `atMin` = null
 * when not measured. (The automatic paper-trade log keeps its own 1.50R
 * requirement in the mint chains; that is not decided here.)
 */
export function rrStatus(rr: number | null, min: number = RR_MIN): { text: string; atMin: boolean | null } {
  if (rr == null || !Number.isFinite(rr)) return { text: 'Confirmed — R:R not measured', atMin: null };
  if (rr < min) return { text: `Confirmed — R:R ${floor2(rr).toFixed(2)}R < ${min.toFixed(2)}R`, atMin: false };
  return { text: `Confirmed — R:R ${rr.toFixed(2)}R ≥ ${min.toFixed(2)}R`, atMin: true };
}

/** The binding R:R: the lower of the measured ones (null when none is measured). */
export function bindingRR(...values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? Math.min(...v) : null;
}

// ---------------- S1: keep-alive on closed bars ----------------

export interface ClosedBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** What a kept-alive S1 lifecycle carries (persisted on the lifecycle in the live state). */
export interface StructureKeepAlive {
  /** When it entered keep-alive (epoch ms: the bar close / refusal time). */
  since: number;
  /** Why: the engine's LOW_RR at confirmation, or an R:R-only refusal at the fill. */
  cause: 'LOW_RR_AT_CONFIRM' | 'RR_REFUSED_AT_FILL';
  /** The newest closed bar (open time) it was evaluated on. */
  lastBarTime: number | null;
  /** The closed bar (open time) of its last fill attempt — at most one per closed bar. */
  lastAttemptBar: number | null;
  /** Underlying reference entry and gross R:R at the last evaluation. */
  reference: number | null;
  grossRR: number | null;
  ended: { reason: string; at: number } | null;
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

/** Gross R:R to T1 from an underlying reference, with the setup's own stop. */
export function grossRRFrom(lc: Pick<LiveLifecycle, 'stop' | 't1'>, reference: number | null): number | null {
  if (reference == null || lc.stop == null || lc.t1 == null) return null;
  const risk = Math.abs(reference - lc.stop);
  const reward = Math.abs(lc.t1.price - reference);
  return risk > 0 ? Math.round((reward / risk) * 100) / 100 : null;
}

/**
 * Advance a kept-alive S1 lifecycle over the closed bars after its last
 * evaluation (bars ≤ the newest closed bar only). Ends it — permanently — on
 * the engine's own invalidations: a close beyond the sweep extreme
 * (SWEEP_RECLAIMED), the stop traded (STOP_TRADED), T1 traded before any fill
 * (MISSED), or the fill window running out (NO_FILL, the engine's
 * fillWithinBars from the moment it was kept alive). Pure.
 */
export function advanceStructureKeepAlive(
  lc: Pick<LiveLifecycle, 'direction' | 'entry' | 'zone' | 'stop' | 't1' | 'sweepExtreme'>,
  ka: StructureKeepAlive,
  closedBars: readonly ClosedBar[],
  barMs: number,
  fillWithinBars: number
): StructureKeepAlive {
  if (ka.ended || lc.stop == null || lc.t1 == null || lc.entry == null) return ka;
  const bear = lc.direction === 'BEARISH';
  const after = closedBars.filter((b) => b.time + barMs > ka.since);
  const fresh = after.filter((b) => ka.lastBarTime == null || b.time > ka.lastBarTime);
  if (fresh.length === 0) return ka;
  let next: StructureKeepAlive = { ...ka };
  for (const b of fresh) {
    const closeAt = b.time + barMs;
    const end = (reason: string): StructureKeepAlive => ({ ...next, lastBarTime: b.time, ended: { reason, at: closeAt } });
    if (bear ? b.high >= lc.stop : b.low <= lc.stop) return end('STOP_TRADED');
    if (bear ? b.close > lc.sweepExtreme : b.close < lc.sweepExtreme) return end('SWEEP_RECLAIMED');
    if (bear ? b.low <= lc.t1.price : b.high >= lc.t1.price) return end('MISSED');
    const barsKept = after.filter((x) => x.time <= b.time).length;
    if (barsKept > fillWithinBars) return end('NO_FILL');
    const reference = structureReference(lc, b.close);
    next = { ...next, lastBarTime: b.time, reference, grossRR: grossRRFrom(lc, reference) };
  }
  return next;
}

/**
 * One poll's keep-alive step for an S1 lifecycle: start it when the engine
 * confirmed the setup below 1.50R (LOW_RR, with a stop and a T1), then
 * advance it over the closed bars. A lifecycle with a live outcome (traded or
 * refused for good) is never kept alive. Returns the new keep-alive state, or
 * undefined when the lifecycle is not kept alive. Pure.
 */
export function keepAliveStep(
  lc: Pick<LiveLifecycle, 'stage' | 'stageAt' | 'direction' | 'entry' | 'zone' | 'stop' | 't1' | 'sweepExtreme' | 'rToT1' | 'live' | 'keepAlive'>,
  closedBars: readonly ClosedBar[],
  barMs: number,
  fillWithinBars: number
): StructureKeepAlive | undefined {
  if (lc.live != null) return lc.keepAlive;
  let ka = lc.keepAlive;
  if (!ka && lc.stage === 'LOW_RR' && lc.entry != null && lc.stop != null && lc.t1 != null) {
    ka = { since: lc.stageAt, cause: 'LOW_RR_AT_CONFIRM', lastBarTime: null, lastAttemptBar: null, reference: lc.entry, grossRR: lc.rToT1, ended: null };
  }
  return ka && !ka.ended ? advanceStructureKeepAlive(lc, ka, closedBars, barMs, fillWithinBars) : ka;
}

/**
 * Has a SHOWN S1 setup ended — by S1's own genuine rules only (stop traded,
 * sweep reclaimed, T1 traded before a fill, the fill window)? Re-derived from
 * the closed bars since it was confirmed, so a refusal by the automatic
 * paper-trade log (R:R, cooldown, cost…) never ends what is shown. Null =
 * still confirmed (or never confirmed). Pure; bars ≤ the newest closed bar.
 */
export function structureDisplayEnd(
  lc: Pick<LiveLifecycle, 'stage' | 'stageAt' | 'confirmedAt' | 'keepAlive' | 'direction' | 'entry' | 'zone' | 'stop' | 't1' | 'sweepExtreme'>,
  closedBars: readonly ClosedBar[],
  barMs: number,
  fillWithinBars: number
): { reason: string; at: number } | null {
  const since = lc.keepAlive?.since ?? lc.confirmedAt ?? (lc.stage === 'LOW_RR' ? lc.stageAt : null);
  if (since == null) return null;
  const fresh: StructureKeepAlive = { since, cause: 'LOW_RR_AT_CONFIRM', lastBarTime: null, lastAttemptBar: null, reference: null, grossRR: null, ended: null };
  return advanceStructureKeepAlive(lc, fresh, closedBars, barMs, fillWithinBars).ended;
}

/** A confirmed S1 setup that is shown: it reached CONFIRMED (any R:R), or the engine confirmed it below 1.50R (LOW_RR with a T1). */
export function isShownStructureSetup(lc: Pick<LiveLifecycle, 'stage' | 'confirmedAt' | 'keepAlive' | 'entry' | 'stop' | 't1'>): boolean {
  if (lc.entry == null || lc.stop == null || lc.t1 == null) return false;
  return lc.confirmedAt != null || lc.keepAlive != null || lc.stage === 'LOW_RR';
}

// ---------------- the per-setup lifecycle record ----------------

export type WatchEventType = 'WATCH_STARTED' | 'REEVALUATED' | 'RR_RECOVERED' | 'STRIKE_CHANGED' | 'OPTION_BUILD_FAILED' | 'WATCH_ENDED';

export interface WatchUpdate {
  id: string;
  source: string;
  direction: 'BULLISH' | 'BEARISH';
  parentId: string | null;
  /** Decision time of this evaluation (the evaluated bar's close, or the check time for the indicator's cadence). */
  at: number;
  /** The closed bar (open time) this evaluation read up to. */
  barTime: number | null;
  /** The binding R:R this evaluation measured. */
  statusRR: number | null;
  grossRR: number | null;
  netRR: number | null;
  /** Informational: the first check (other than R:R) that would stop the AUTOMATIC paper-trade log now (null = none). Never hides or ends the setup. */
  block: { code: string | null; reason: string } | null;
  plan: OptionTradePlan | null;
  /** True when the option leg itself could not be built (every strike failed). */
  optionBuildFailed: boolean;
  underlying: { entry: number | null; sl: number | null; t1: number | null; t2: number | null };
  expiresAt: number | null;
  /** Set when this evaluation ends the setup (invalidation, expiry, traded). */
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
 * and list what happened. Pure. An ended record is never reopened.
 */
export function applyWatchUpdate(prev: SetupWatchRow | null, u: WatchUpdate, min: number = RR_MIN): { row: SetupWatchRow; events: WatchEventType[] } {
  if (prev?.ended) return { row: prev, events: [] };
  const { text, atMin } = rrStatus(u.statusRR, min);
  const events: WatchEventType[] = [];
  if (!prev) events.push('WATCH_STARTED');
  else if (u.barTime !== prev.lastBarTime) events.push('REEVALUATED');
  const wasBelow = prev ? prev.statusRR == null || prev.statusRR < min : false;
  const nowAtOrAbove = u.statusRR != null && u.statusRR >= min;
  const recovered = prev != null && wasBelow && nowAtOrAbove && !prev.rrRecovered;
  if (recovered) events.push('RR_RECOVERED');
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
    rrAtMin: atMin,
    blockCode: u.block?.code ?? null,
    blockReason: u.block?.reason ?? null,
    plan: u.plan ?? prev?.plan ?? null,
    initial: prev?.initial ?? snap,
    current: snap,
    startedBelowMin: prev ? prev.startedBelowMin : !(u.statusRR != null && u.statusRR >= min),
    rrRecovered: (prev?.rrRecovered ?? false) || recovered,
    firstAtMinAt: prev?.firstAtMinAt ?? (atMin === true && !u.ended ? u.at : null),
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

/** An update that only ends a row (traded, invalidated, expired, bias flipped), carrying its last measurements. Pure. */
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

