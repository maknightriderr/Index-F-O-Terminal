// ============================================================
// TRIGGER-FAMILY ROUTER (live)
// ============================================================
// The layer above the trigger families. On every poll it reads the symbol's
// closed 15m bars, builds the session's event log, and evaluates every
// trigger family the event engine defines — with or without a displacement —
// at each newly closed bar:
//
//   market event → candidate (a trigger's exact rule) → evidence (the events
//   it used, market state) → move potential → entry timing → risk validation
//   (geometry, session guards) → option feasibility (cost on the live chain)
//
// Displacement is NOT checked here. It is S1's own requirement (the structure
// engine, which runs unchanged beside this router) and C2's anchor; for every
// other family it is only an event in the log.
//
// Several families often see the same move. Candidates are grouped into
// parent setups and ARBITRATED (event-engine arbitration.ts): one selected
// setup per parent, chosen at the parent's first bar with an eligible
// candidate from decision-time fields only, then fixed; every other
// candidate is stored as an ALTERNATIVE or INELIGIBLE with its reason. Two
// arbitrations run: observation (SHADOW and up — which setup would be
// chosen) and trading (PAPER and up — the only one that may trade). Different
// parents stay separate opportunities, subject to the slot and exposure rules.
//
// What happens next depends on the trigger's own live stage
// (resolveTriggerStage):
//   SHADOW   recorded to setup_events (decision SHADOW) and graded forward —
//            never traded. This is the default for every unproven family.
//   PAPER    returned to the caller, which mints through the structure
//            engine's own chain (resolveStructureSetup: the same safety gates,
//            option leg and exits). No trigger is PAPER until a code-level
//            promotion record exists (TRIGGER_PROMOTIONS is empty).
//   RESEARCH / RETIRED  not evaluated live.
//
// Every failure is logged and returns null: the router can never block or
// alter the structure engine, the consensus engine, or a held trade.
// ============================================================

import {
  prepareMomentumSeries,
  buildSeriesContext,
  runSessionEvents,
  evaluateTriggersAt,
  groupIntoParents,
  arbitrateParents,
  TRIGGER_REGISTRY,
  TRIGGERS_BY_ID,
  EVENT_ENGINE_TRIGGER_IDS,
  BAR_MS_15M,
  type MomentumBar,
  type TriggerCandidate,
  type ArbitrationDecision,
  type FixedSelection,
} from '@fno/analytics';
import { getSessionWindow, type Exchange, type OptionChain, type TradingMode } from '@fno/shared';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import {
  resolveTriggerStage,
  PAPER_TRADING_STAGES,
  EVENT_ENGINE_VERSION,
  RISK_VERSION,
  OPTION_VERSION,
  COST_VERSION,
  FNO_VALIDATION_PARAMS,
  STRUCTURE_PARAMS,
  type LiveTriggerStage,
} from '../config/trading-flags.js';
import { measureSetupCost, type SetupCostMeasurement } from './setup-cost.js';
import { recordSetupEvent } from './setup-events.js';
import type { LiveLifecycle } from './structure-live.js';

/** Newly closed bars evaluated per poll at most (a catch-up after a quiet spell). */
const MAX_CATCHUP_BARS = 8;
const EVAL_STATE_TTL_SECONDS = 36 * 60 * 60;
const CANDIDATE_DEDUPE_TTL_SECONDS = 3 * 24 * 60 * 60;
/** Settle after the open (the live engine's own). */
const SETTLE_MS = 5 * 60 * 1000;

export interface RiskValidation {
  /** TRADE = valid stop, a real untaken target ≥ 1.5R; anything else is the reason it would not trade. */
  bucket: TriggerCandidate['bucket'];
  /** Inside the session guards: not in the first 5 minutes, not within the structure closing guard. */
  sessionOk: boolean;
  /** Round-trip cost as % of the premium, on the live chain's leg (null without a quote). */
  costPct: number | null;
  costOk: boolean | null;
  /** All of the above pass. A SHADOW candidate with wouldTrade = true is what a PAPER stage would have minted. */
  wouldTrade: boolean;
  reason: string | null;
}

export interface RoutedCandidate {
  candidate: TriggerCandidate;
  stage: LiveTriggerStage;
  risk: RiskValidation;
  cost: SetupCostMeasurement | null;
  lifecycleId: string;
  /** Observation arbitration (SHADOW and up): which setup this parent move would select, and this candidate's role. */
  arbitration?: ArbitrationDecision | null;
  /** Trading arbitration (PAPER and up): the one setup per parent that may trade. */
  tradeArbitration?: ArbitrationDecision | null;
}

/** Each trigger's live stage (S1 is the structure engine's own; it is listed for completeness). */
export function liveTriggerStages(): Record<string, LiveTriggerStage> {
  return Object.fromEntries(TRIGGER_REGISTRY.map((t) => [t.triggerId, resolveTriggerStage(t.triggerId, t.status)]));
}

/** The triggers the router evaluates live: event-engine rules at SHADOW or above. */
export function liveRoutedTriggerIds(stages: Record<string, LiveTriggerStage> = liveTriggerStages()): string[] {
  return EVENT_ENGINE_TRIGGER_IDS.filter((id) => ['SHADOW', ...PAPER_TRADING_STAGES].includes(stages[id]));
}

export function routedLifecycleId(exchange: Exchange, underlying: string, c: TriggerCandidate): string {
  return `${exchange}:${underlying}:MP:${c.triggerId}:${c.direction}:${c.decisionTime}`;
}

/** Pure: the risk verdict for one candidate. */
export function validateCandidateRisk(c: TriggerCandidate, args: { sessionOk: boolean; costPct: number | null; maxCostPct: number }): RiskValidation {
  const costOk = args.costPct == null ? null : args.costPct <= args.maxCostPct;
  const reasons: string[] = [];
  if (c.bucket !== 'TRADE') reasons.push(c.bucket === 'LOW_RR' ? `LOW_RR: T1 only ${c.rToT1}R away (needs 1.5R)` : c.bucket === 'NO_TARGET' ? 'NO_TARGET: no untaken pool ahead' : 'INVALID_STOP');
  if (!args.sessionOk) reasons.push('SESSION_GUARD: outside the allowed entry window');
  if (costOk === false) reasons.push(`COST_TOO_HIGH: ~${args.costPct}% of premium round trip`);
  return {
    bucket: c.bucket,
    sessionOk: args.sessionOk,
    costPct: args.costPct,
    costOk,
    wouldTrade: c.bucket === 'TRADE' && args.sessionOk && costOk !== false,
    reason: reasons.length ? reasons.join('; ') : null,
  };
}

/**
 * Pure: a PAPER-stage candidate as the lifecycle shape the structure engine's
 * mint chain reads. The fill price is the decision bar's close (the rule
 * decides at that close); `sweepExtreme` carries the rule's invalidation
 * extreme, which the structure exits (SWEEP_RECLAIMED) watch.
 */
export function lifecycleFromCandidate(rc: RoutedCandidate): LiveLifecycle {
  const c = rc.candidate;
  const buf = 0.1 * c.atr;
  const invalidation = c.direction === 'BULLISH' ? c.stop + buf : c.stop - buf;
  return {
    id: rc.lifecycleId,
    direction: c.direction,
    stage: 'ENTRY',
    timeframe: '15m',
    recorded: 0,
    pool: { kind: c.triggerId, price: c.anchorPrice, rank: 0 },
    zone: null,
    entry: c.entry,
    stop: c.stop,
    t1: c.t1 ? { kind: c.t1.kind, price: c.t1.price } : null,
    t2: c.t2 ? { kind: c.t2.kind, price: c.t2.price } : null,
    rToT1: c.rToT1,
    score: null,
    sweepExtreme: Math.round(invalidation * 100) / 100,
    atr: c.atr,
    displacementBodyAtr: null,
    stageAt: c.decisionTime + BAR_MS_15M,
    reason: null,
    engineFillBarTime: c.decisionTime,
    confirmedAt: null,
    rejectionFillPrice: c.entry,
    live: null,
    triggerId: c.triggerId,
  };
}

function legFor(chain: OptionChain, side: 'CE' | 'PE') {
  const row = chain.strikes.find((s) => s.strike === chain.atmStrike);
  return side === 'CE' ? row?.call : row?.put;
}

/** The option leg's cost for a candidate, on the ATM leg of the live chain (labelled ATM_PROXY: no contract was chosen). */
function costOnChain(c: TriggerCandidate, chain: OptionChain | null): SetupCostMeasurement | null {
  if (!chain) return null;
  const side = c.direction === 'BULLISH' ? 'CE' : 'PE';
  const leg = legFor(chain, side);
  const base = { entry: c.entry, stop: c.stop, t1: c.t1?.price ?? null, atr: c.atr, costVersion: COST_VERSION };
  if (!leg) return measureSetupCost({ ...base, option: null });
  const twoSided = leg.bid > 0 && leg.ask > leg.bid;
  return measureSetupCost({
    ...base,
    option: {
      side,
      strike: chain.atmStrike,
      expiry: chain.expiry ?? null,
      strikeBasis: 'ATM_PROXY',
      premium: twoSided ? (leg.bid + leg.ask) / 2 : leg.ltp > 0 ? leg.ltp : null,
      bid: leg.bid > 0 ? leg.bid : null,
      ask: leg.ask > 0 ? leg.ask : null,
      delta: Number.isFinite(leg.delta) ? leg.delta : null,
      lotSize: chain.lotSize > 0 ? chain.lotSize : null,
    },
  });
}

/**
 * Evaluates the newly closed bars of today's session. Returns the PAPER-stage
 * candidates of the newest bar that would trade (normally none), or null on
 * any failure. SHADOW candidates are recorded once each.
 */
export async function routeTriggerFamilies(args: { underlying: string; exchange: Exchange; mode: TradingMode; bars: MomentumBar[]; chain: OptionChain | null; now: number }): Promise<{ paper: RoutedCandidate[]; evaluated: number } | null> {
  const { underlying, exchange, mode, bars, chain, now } = args;
  try {
    if (mode !== 'INTRADAY' || bars.length < 30) return { paper: [], evaluated: 0 };
    const stages = liveTriggerStages();
    const ids = liveRoutedTriggerIds(stages);
    if (ids.length === 0) return { paper: [], evaluated: 0 };

    const series = prepareMomentumSeries(bars);
    const s = series.sessionStarts.length - 1;
    const session = series.sessionDates[s];
    const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (session !== today) return { paper: [], evaluated: 0 };
    const window = getSessionWindow(exchange, session);
    if (!window) return { paper: [], evaluated: 0 };

    const stateKey = `mp_eval:${exchange}:${underlying}:${mode}`;
    const lastDone = Number((await redis.get(stateKey).catch(() => null)) ?? 0);
    const ctx = buildSeriesContext(series);
    const start = series.sessionStarts[s];
    const end = ctx.sessionEnd(s);
    const todo: number[] = [];
    for (let i = Math.max(start, end - MAX_CATCHUP_BARS + 1); i <= end; i++) if (series.bars[i].time > lastDone) todo.push(i);
    if (todo.length === 0) return { paper: [], evaluated: 0 };

    const log = runSessionEvents(ctx, s);
    const closingGuardMs = STRUCTURE_PARAMS.STRUCTURE_CLOSING_GUARD_MIN * 60 * 1000;
    const todoSet = new Set(todo);

    // 1. Every trigger, independently, on every bar of today's session so far
    //    (each rule reads only bars up to its own decision bar). One rule
    //    failing — no displacement, no target — never stops another.
    const all: TriggerCandidate[] = [];
    for (let i = start; i <= end; i++) all.push(...evaluateTriggersAt(ctx, log, i, ids));

    // 2. Qualify each: risk geometry, session window, and option cost on the
    //    live quote (only meaningful for the bar that just closed).
    const routed: RoutedCandidate[] = all.map((c) => {
      const barTime = c.decisionTime;
      const sessionOk = barTime - window.open >= SETTLE_MS && window.close - (barTime + BAR_MS_15M) >= closingGuardMs;
      const cost = c.decisionIndex === end ? costOnChain(c, chain) : null;
      const risk = validateCandidateRisk(c, { sessionOk, costPct: cost?.costPctOfPremium != null ? Math.round(cost.costPctOfPremium * 100) / 100 : null, maxCostPct: FNO_VALIDATION_PARAMS.MAX_COST_PCT_OF_PREMIUM });
      return { candidate: c, stage: stages[c.triggerId], risk, cost, lifecycleId: routedLifecycleId(exchange, underlying, c) };
    });

    // 3. Group by parent move, then 4. arbitrate one setup per parent — once
    //    for observation (SHADOW and up) and once for trading (PAPER and up).
    //    A bar settled by an earlier evaluation keeps its verdict: its
    //    selection (if any) is persisted, and its other candidates cannot be
    //    re-selected with hindsight.
    const parents = groupIntoParents(all, new Map([[session, log]]));
    const arbitrate = async (modeKey: 'observe' | 'trade', allowed: LiveTriggerStage[]) => {
      const selKey = `mp_sel:${modeKey}:${exchange}:${underlying}:${session}`;
      const fixed: Record<string, FixedSelection> = JSON.parse((await redis.get(selKey).catch(() => null)) ?? '{}');
      const decisions = arbitrateParents(parents, all, (idx) => {
        const r = routed[idx];
        const fresh = todoSet.has(r.candidate.decisionIndex);
        return {
          eligible: fresh && r.risk.wouldTrade,
          ineligibleReason: fresh ? r.risk.reason : 'Decided at an earlier evaluation',
          stageAllowed: allowed.includes(r.stage),
          netR: r.cost?.netR ?? null,
        };
      }, fixed);
      let changed = false;
      for (const [idx, d] of decisions) {
        const c = all[idx];
        if (d.role === 'SELECTED' && todoSet.has(c.decisionIndex) && !fixed[d.parentId]) {
          fixed[d.parentId] = { triggerId: c.triggerId, decisionIndex: c.decisionIndex };
          changed = true;
        }
      }
      if (changed) await redis.set(selKey, JSON.stringify(fixed), 'EX', EVAL_STATE_TTL_SECONDS).catch(() => undefined);
      return decisions;
    };
    const observed = await arbitrate('observe', ['SHADOW', ...PAPER_TRADING_STAGES]);
    const traded = await arbitrate('trade', [...PAPER_TRADING_STAGES]);

    // 5. Record every new candidate with its role; hand the slot only the
    //    trading selection of the bar that just closed (PAPER_RESEARCH and up).
    const paper: RoutedCandidate[] = [];
    for (let idx = 0; idx < all.length; idx++) {
      const rc = routed[idx];
      if (!todoSet.has(rc.candidate.decisionIndex)) continue;
      rc.arbitration = observed.get(idx) ?? null;
      rc.tradeArbitration = traded.get(idx) ?? null;
      await recordCandidate(underlying, exchange, rc);
      if (rc.tradeArbitration?.role === 'SELECTED' && rc.candidate.decisionIndex === end && PAPER_TRADING_STAGES.includes(rc.stage)) paper.push(rc);
    }
    await redis.set(stateKey, String(series.bars[end].time), 'EX', EVAL_STATE_TTL_SECONDS).catch(() => undefined);
    return { paper, evaluated: todo.length };
  } catch (err: any) {
    logger.warn({ error: err.message, underlying, exchange }, 'Trigger router: evaluation failed — structure and consensus engines unaffected');
    return null;
  }
}

async function recordCandidate(underlying: string, exchange: Exchange, rc: RoutedCandidate): Promise<void> {
  const claimed = await redis.set(`mp_cand:${rc.lifecycleId}`, '1', 'EX', CANDIDATE_DEDUPE_TTL_SECONDS, 'NX').catch(() => 'OK');
  if (claimed !== 'OK') return;
  const c = rc.candidate;
  const def = TRIGGERS_BY_ID.get(c.triggerId);
  recordSetupEvent({
    time: new Date(c.decisionTime + BAR_MS_15M),
    instrument: underlying,
    exchange,
    timeframe: '15m',
    lifecycleId: rc.lifecycleId,
    direction: c.direction,
    fromStage: null,
    toStage: 'CANDIDATE',
    reason: rc.risk.reason,
    poolType: c.t1?.kind ?? null,
    poolPrice: c.anchorPrice,
    triggerType: c.triggerId,
    entry: c.entry,
    stop: c.stop,
    t1: c.t1?.price ?? null,
    t2: c.t2?.price ?? null,
    scoreTotal: null,
    atr: c.atr,
    cost: rc.cost,
    context: {
      stage: rc.stage,
      family: c.family,
      bucket: c.bucket,
      marketState: c.marketState,
      movePotential: c.movePotential,
      timing: c.timing,
      risk: rc.risk,
      eventIds: c.eventIds,
      anchorEventId: c.anchorEventId,
      // One setup per parent move: this candidate's role, and why it was or wasn't the one.
      arbitration: rc.arbitration
        ? { parentId: rc.arbitration.parentId, role: rc.arbitration.role, reason: rc.arbitration.reason, rank: rc.arbitration.rank, selectedTriggerId: rc.arbitration.selectedTriggerId }
        : null,
      tradeArbitration: rc.tradeArbitration ? { role: rc.tradeArbitration.role, reason: rc.tradeArbitration.reason, selectedTriggerId: rc.tradeArbitration.selectedTriggerId } : null,
    },
    versions: { strategyVersion: EVENT_ENGINE_VERSION, triggerVersion: `${c.triggerId}-${def?.version ?? '1.0'}`, riskVersion: RISK_VERSION, optionVersion: OPTION_VERSION, costVersion: COST_VERSION },
  });
}
