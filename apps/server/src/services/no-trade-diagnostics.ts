// ============================================================
// NO TRADE DIAGNOSTICS
// ============================================================
// Every NO TRADE says why, in four parts:
//   candidates evaluated  every candidate the engines handed the slot, with the
//                         stage and code it failed on and the reason
//   best rejected         the candidate that ranked highest before the build,
//                         its metrics and confirmations
//   limiting factor       the deciding constraint (the most common failure, or,
//                         with no candidate at all, what no engine produced)
//   missing confirmation  what the best rejected candidate (or the engines)
//                         still lacked
// Pure: it reads the slot's records and the engines' own state only.
// ============================================================

import type { NoTradeCandidate, NoTradeDiagnostics, NoTradeStage } from '@fno/shared';
import type { SlotArbitrationRecord } from './slot-arbitration.js';

const SAFETY = new Set(['RISK_OFF', 'MARKET_CLOSED', 'OPENING_HOUR', 'CLOSING_HOUR', 'POST_LOSS_COOLDOWN', 'CONCURRENT_EXPOSURE', 'RELIABILITY_FILTER', 'POSITIONING_CONFLICT', 'LOW_SETUP_QUALITY', 'DIRECTION_LOCKED', 'SAME_SYMBOL_SIDE', 'CONSENSUS_OFF', 'NEUTRAL_BIAS', 'POOR_LOCATION', 'INSUFFICIENT_ROOM']);
const SEQUENCE = new Set(['STRUCTURE_SEQUENCE', 'TRIGGER_QUALITY']);
const OPTION = new Set(['NO_QUOTE', 'WIDE_SPREAD', 'POOR_OPTION_QUALITY', 'LOW_OPTION_LIQUIDITY', 'UNREALISTIC_TARGET', 'COST_EXCEEDS_EDGE', 'COST_TOO_HIGH', 'STOP_INSIDE_NOISE', 'OPTION_DELTA_OUT_OF_BAND', 'REWARD_RISK_TOO_LOW', 'NO_CHAIN']);
const PRE_MINT = new Set(['STALE_QUOTE', 'MINT_FAILED']);

/** The stage a refusal belongs to. */
export function noTradeStage(code: string | null, optionBuildFailure: string | null): NoTradeStage {
  if (code === 'ENGINE_ERROR') return 'ENGINE_ERROR';
  if (code === 'PARENT_ALREADY_TRADED') return 'PARENT_ALREADY_TRADED';
  if (code === 'SLOT_OCCUPIED') return 'SLOT_OCCUPIED';
  if (code && PRE_MINT.has(code)) return 'DATA_QUALITY';
  if (optionBuildFailure != null || (code != null && OPTION.has(code))) return 'OPTION_COST_LIQUIDITY';
  if (code && SEQUENCE.has(code)) return 'SEQUENCE';
  if (code && SAFETY.has(code)) return 'SAFETY_GATE';
  return 'OTHER';
}

const STAGE_TEXT: Record<NoTradeStage, string> = {
  SAFETY_GATE: 'a safety / session / cooldown gate',
  SEQUENCE: 'the setup sequence (price no longer between stop and target)',
  OPTION_COST_LIQUIDITY: 'the option leg (cost, liquidity, spread, delta band or a realistic target)',
  DATA_QUALITY: 'data quality at mint time (stale or one-sided quote)',
  PARENT_ALREADY_TRADED: 'one trade per market move (this move already traded today)',
  SLOT_OCCUPIED: 'one open trade per symbol (a trade is already open)',
  ENGINE_ERROR: 'an engine error',
  OTHER: 'another check',
};

/** What a code says the candidate still needed. */
const NEEDS: Record<string, string> = {
  STALE_QUOTE: 'a fresh option quote',
  NO_QUOTE: 'a live two-sided option quote',
  WIDE_SPREAD: 'a tighter bid-ask spread',
  LOW_OPTION_LIQUIDITY: 'option volume / open interest',
  POOR_OPTION_QUALITY: 'a tradeable contract (premium / liquidity floors)',
  COST_TOO_HIGH: 'a round-trip cost inside the ceiling',
  COST_EXCEEDS_EDGE: 'a target that pays more than costs and decay',
  UNREALISTIC_TARGET: 'an expected move that pays more than the time decay over the hold',
  STOP_INSIDE_NOISE: 'a stop outside the underlying noise within the premium cap',
  OPTION_DELTA_OUT_OF_BAND: 'a strike inside the delta band',
  STRUCTURE_SEQUENCE: 'price still between the stop and T1',
  PARENT_ALREADY_TRADED: 'a new, independent market move',
  SLOT_OCCUPIED: 'the open trade to close',
  POST_LOSS_COOLDOWN: 'the post-loss cooldown to pass',
  CLOSING_HOUR: 'time before the closing guard',
  OPENING_HOUR: 'the opening settle to pass',
  RISK_OFF: 'the risk-off state to clear',
  NEUTRAL_BIAS: 'a directional consensus',
  POSITIONING_CONFLICT: 'positioning not uniformly against the direction',
};

export interface EngineSummaryInput {
  /** S1: its lifecycles (stage + direction), whether a fill was claimed this check. */
  structure: { enabled: boolean; lifecycles: Array<{ stage: string; direction: string }>; fillClaimed: boolean } | null;
  /** Trigger families: paper-stage candidates of the newest bar, and failed triggers. */
  families: { paperCandidates: number; triggerFailures: number; evaluated: boolean } | null;
  /** Indicator engine: its direction and its own result when it did not hand in a candidate. */
  indicator: { direction: string; code: string | null; reason: string | null } | null;
}

/** Pure: what each engine contributed this check, in words. */
export function engineSummaries(e: EngineSummaryInput): NoTradeDiagnostics['engines'] {
  let s1 = 'Structure engine off.';
  if (e.structure?.enabled) {
    const by = (st: string) => e.structure!.lifecycles.filter((l) => l.stage === st).length;
    const confirmed = by('CONFIRMED');
    s1 = e.structure.fillClaimed
      ? 'A confirmed setup filled this check.'
      : confirmed > 0
        ? `${confirmed} confirmed setup(s) waiting — price has not returned to the zone (limit not filled).`
        : by('DEVELOPING') > 0
          ? 'A sweep is developing — displacement / zone not yet confirmed.'
          : by('WATCH') > 0
            ? 'Watching a pool — no sweep yet.'
            : 'No structure setup today.';
  }
  const families = !e.families
    ? 'Trigger families not evaluated (positional mode, or not today\'s session).'
    : !e.families.evaluated
      ? 'No new closed bar since the last evaluation.'
      : `${e.families.paperCandidates} paper-stage candidate(s) on the newest closed bar${e.families.triggerFailures ? `; ${e.families.triggerFailures} trigger(s) failed and were skipped` : ''}.`;
  const indicator = !e.indicator
    ? 'Indicator engine did not run.'
    : e.indicator.direction === 'NEUTRAL'
      ? 'Bias is neutral — no directional consensus (supporting evidence only).'
      : e.indicator.code
        ? `${e.indicator.direction}: ${e.indicator.code}${e.indicator.reason ? ` — ${e.indicator.reason}` : ''}`
        : `${e.indicator.direction}: built a candidate.`;
  return { structure: s1, families, indicator };
}

/** Pure: the NO TRADE explanation from the slot's records and the engines' state. */
export function buildNoTradeDiagnostics(records: readonly SlotArbitrationRecord[], engines: EngineSummaryInput): NoTradeDiagnostics {
  const candidates: NoTradeCandidate[] = [...records]
    .sort((a, b) => a.preBuildRank - b.preBuildRank || a.slot.candidateId.localeCompare(b.slot.candidateId))
    .map((r) => ({
      candidateId: r.slot.candidateId,
      source: r.slot.source,
      direction: r.slot.direction,
      parentId: r.slot.parentId,
      preBuildRank: r.preBuildRank,
      stage: noTradeStage(r.refusalCode, r.optionBuildFailure),
      code: r.refusalCode,
      reason: r.reason,
      metrics: {
        timing: String(r.slot.timingClass),
        movePotential: String(r.slot.movePotential),
        entryQuality: typeof r.slot.entryQuality === 'number' ? r.slot.entryQuality : null,
        netRR: typeof r.slot.netRR === 'number' ? r.slot.netRR : null,
        confirmations: typeof r.slot.confirmations === 'number' ? r.slot.confirmations : null,
      },
      confirmationDetail: r.slot.confirmationDetail ?? null,
    }));
  const summaries = engineSummaries(engines);
  if (candidates.length === 0) {
    const missing = engines.indicator?.direction === 'NEUTRAL' && !engines.structure?.lifecycles.some((l) => l.stage === 'CONFIRMED')
      ? 'A confirmed structure setup, a trigger on the newest bar, or a directional consensus.'
      : engines.structure?.lifecycles.some((l) => l.stage === 'CONFIRMED')
        ? 'Price returning to a confirmed zone (the limit fill).'
        : 'A trigger-family or structure setup on the newest closed bar.';
    return {
      candidatesEvaluated: 0,
      candidates: [],
      bestRejected: null,
      limitingFactor: { code: 'NO_CANDIDATE', stage: null, summary: 'No engine produced a candidate this check.' },
      missingConfirmation: missing,
      engines: summaries,
    };
  }
  // The deciding constraint: the most common stage (ties → the one the best candidate hit).
  const counts = new Map<NoTradeStage, number>();
  for (const c of candidates) counts.set(c.stage, (counts.get(c.stage) ?? 0) + 1);
  const best = candidates[0];
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] === best.stage ? -1 : b[0] === best.stage ? 1 : a[0].localeCompare(b[0])))[0][0];
  const codeOf = (st: NoTradeStage) => candidates.find((c) => c.stage === st)?.code ?? null;
  const absent = best.confirmationDetail
    ? [
        !best.confirmationDetail.liquiditySweep && 'a liquidity sweep',
        !best.confirmationDetail.displacement && 'a displacement',
        !best.confirmationDetail.structureZone && 'an FVG / zone / structure shift',
        best.confirmationDetail.optionChain === false && 'option-chain positioning in its direction',
      ].filter((x): x is string => !!x)
    : [];
  const need = best.code ? NEEDS[best.code] ?? null : null;
  return {
    candidatesEvaluated: candidates.length,
    candidates,
    bestRejected: { ...best, why: 'Highest-ranked candidate on the pre-build criteria (timing, move potential, entry quality, confirmations).' },
    limitingFactor: { code: codeOf(top), stage: top, summary: `${counts.get(top)} of ${candidates.length} candidate(s) failed on ${STAGE_TEXT[top]}.` },
    missingConfirmation: [need ? `It needed ${need}.` : null, absent.length ? `Unconfirmed: ${absent.join(', ')}.` : null].filter(Boolean).join(' ') || null,
    engines: summaries,
  };
}
