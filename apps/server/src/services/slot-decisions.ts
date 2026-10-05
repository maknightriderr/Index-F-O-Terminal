// ============================================================
// SLOT DECISIONS — what the slot did on each decision bar (measurement only)
// ============================================================
// One row per symbol / mode / decision bar whose slot was free: MINTED, NO
// TRADE (candidates, every one failed) or NO_CANDIDATE. A bar whose slot was
// held by an open trade is not a decision and writes nothing. Repeated polls
// of the same bar write the first NO TRADE / NO_CANDIDATE once; a mint is
// always written (the diagnostics read a bar as MINTED when any row of it is).
//
// It records how far the ranking fell through, the candidates that failed
// their final check, every rejection's code and stage, and each candidate's
// geometry and confirmation count — the inputs the diagnostics endpoint and
// the forward-validation job read. Nothing in the decision path reads it.
// ============================================================

import type { NoTradeDiagnostics } from '@fno/shared';
import { sql } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { NOT_MEASURED, type SlotArbitrationRecord } from './slot-arbitration.js';
import { noTradeStage } from './no-trade-diagnostics.js';
import { schemaFileReady } from './ensure-capture-schema.js';

export const SLOT_DECISIONS_MIGRATION = '037_replay_tapes_forward_validation.sql';

/** Refusal codes that are the option's time decay / cost (theta-adjusted target, cost ceiling). */
export const THETA_COST_CODES: ReadonlySet<string> = new Set(['COST_EXCEEDS_EDGE', 'COST_TOO_HIGH', 'UNREALISTIC_TARGET']);
/** Refusal codes that are the contract's liquidity (quote, spread, volume / OI, premium floors). */
export const LIQUIDITY_CODES: ReadonlySet<string> = new Set(['NO_QUOTE', 'WIDE_SPREAD', 'LOW_OPTION_LIQUIDITY', 'POOR_OPTION_QUALITY']);

export type RejectionCategory = 'THETA_COST' | 'LIQUIDITY' | 'OTHER';
export function rejectionCategory(code: string | null): RejectionCategory {
  if (code && THETA_COST_CODES.has(code)) return 'THETA_COST';
  if (code && LIQUIDITY_CODES.has(code)) return 'LIQUIDITY';
  return 'OTHER';
}

export type SlotOutcome = 'MINTED' | 'NO_TRADE' | 'NO_CANDIDATE';

export interface SlotDecisionCandidate {
  source: string;
  candidateId: string;
  direction: string;
  role: SlotArbitrationRecord['role'];
  rank: number | null;
  preBuildRank: number;
  code: string | null;
  stage: string | null;
  category: RejectionCategory | null;
  finalCheck: boolean;
  confirmations: number | null;
  netRR: number | null;
  decisionTime: number;
  entry: number | null;
  stop: number | null;
  objective: number | null;
}

export interface SlotDecisionRow {
  time: number;
  symbol: string;
  exchange: string;
  mode: string;
  decisionBarTime: number;
  outcome: SlotOutcome;
  candidates: number;
  fellthrough: number;
  preMintFailures: number;
  selectedSource: string | null;
  selectedCandidateId: string | null;
  limitingStage: string | null;
  limitingCode: string | null;
  diagnostics: {
    rejections: { thetaCost: number; liquidity: number; other: number };
    byCode: Record<string, number>;
    candidates: SlotDecisionCandidate[];
  };
  versions: { option: string | null; arbitration: string | null; optionSelection: string | null };
}

const measured = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Pure: the row for one settled slot. `minted` = the slot minted this check. */
export function slotDecisionRow(args: {
  at: number;
  symbol: string;
  exchange: string;
  mode: string;
  decisionBarTime: number;
  records: readonly SlotArbitrationRecord[];
  minted: boolean;
  noTrade: NoTradeDiagnostics | null;
  versions: SlotDecisionRow['versions'];
}): SlotDecisionRow {
  const { records } = args;
  const selected = records.find((r) => r.role === 'SELECTED') ?? null;
  const candidates: SlotDecisionCandidate[] = [...records]
    .sort((a, b) => a.preBuildRank - b.preBuildRank || a.slot.candidateId.localeCompare(b.slot.candidateId))
    .map((r) => {
      const failed = r.role === 'INELIGIBLE';
      const g = r.slot.geometry ?? null;
      return {
        source: r.slot.source,
        candidateId: r.slot.candidateId,
        direction: r.slot.direction,
        role: r.role,
        rank: r.rank,
        preBuildRank: r.preBuildRank,
        code: r.refusalCode,
        stage: failed ? noTradeStage(r.refusalCode, r.optionBuildFailure) : null,
        category: failed ? rejectionCategory(r.refusalCode) : null,
        finalCheck: r.finalCheck === true,
        confirmations: r.slot.confirmations === NOT_MEASURED ? null : measured(r.slot.confirmations),
        netRR: measured(r.slot.netRR),
        decisionTime: r.slot.decisionTime,
        entry: g ? measured(g.entry) : null,
        stop: g ? measured(g.stop) : null,
        objective: g ? measured(g.objective) : null,
      };
    });
  const failed = candidates.filter((c) => c.role === 'INELIGIBLE');
  const byCode: Record<string, number> = {};
  for (const c of failed) byCode[c.code ?? 'UNKNOWN'] = (byCode[c.code ?? 'UNKNOWN'] ?? 0) + 1;
  const outcome: SlotOutcome = args.minted ? 'MINTED' : records.length === 0 ? 'NO_CANDIDATE' : 'NO_TRADE';
  return {
    time: args.at,
    symbol: args.symbol,
    exchange: args.exchange,
    mode: args.mode,
    decisionBarTime: args.decisionBarTime,
    outcome,
    candidates: records.length,
    // The selected record's rank is 1 + the built candidates ranked above it that failed their final check.
    fellthrough: args.minted && selected?.rank != null ? selected.rank - 1 : 0,
    preMintFailures: failed.filter((c) => c.finalCheck).length,
    selectedSource: args.minted ? selected?.slot.source ?? null : null,
    selectedCandidateId: args.minted ? selected?.slot.candidateId ?? null : null,
    limitingStage: args.minted ? null : args.noTrade?.limitingFactor?.stage ?? null,
    limitingCode: args.minted ? null : args.noTrade?.limitingFactor?.code ?? null,
    diagnostics: {
      rejections: {
        thetaCost: failed.filter((c) => c.category === 'THETA_COST').length,
        liquidity: failed.filter((c) => c.category === 'LIQUIDITY').length,
        other: failed.filter((c) => c.category === 'OTHER').length,
      },
      byCode,
      candidates,
    },
    versions: args.versions,
  };
}

/** Best-effort write: never throws, never blocks the poll. */
export async function recordSlotDecision(row: SlotDecisionRow): Promise<void> {
  try {
    if (!schemaFileReady(SLOT_DECISIONS_MIGRATION)) return;
    if (row.outcome !== 'MINTED') {
      const first = await redis.set(`slot_decision_logged:${row.exchange}:${row.symbol}:${row.mode}:${row.decisionBarTime}`, '1', 'EX', 60 * 60 * 24, 'NX');
      if (first !== 'OK') return;
    }
    await sql`
      INSERT INTO slot_decisions (time, symbol, exchange, mode, decision_bar_time, outcome, candidates, fellthrough, pre_mint_failures,
        selected_source, selected_candidate_id, limiting_stage, limiting_code, diagnostics, option_version, arbitration_version, option_selection_version)
      VALUES (${new Date(row.time)}, ${row.symbol}, ${row.exchange}, ${row.mode}, ${new Date(row.decisionBarTime)}, ${row.outcome}, ${row.candidates},
        ${row.fellthrough}, ${row.preMintFailures}, ${row.selectedSource}, ${row.selectedCandidateId}, ${row.limitingStage}, ${row.limitingCode},
        ${sql.json(row.diagnostics as any)}, ${row.versions.option}, ${row.versions.arbitration}, ${row.versions.optionSelection})
    `;
  } catch (err: any) {
    logger.warn({ error: err.message, symbol: row.symbol }, 'Slot decision: record failed');
  }
}
