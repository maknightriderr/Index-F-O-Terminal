// ============================================================
// OPTION PLANS (Phase 3, 2026-10-05)
// ============================================================
// Every minted paper trade's option plan is persisted WITH its underlying
// plan (option_plans, migration 035): underlying entry / SL / T1 / T2, the
// option leg and its premium Entry / SL / TSL / T1 / T2, the selected strike
// and every strike the OptionCandidate pipeline evaluated (selected, ranked,
// rejected + stage + reason), and the decision snapshot it came from. The
// plan row never changes; each later change of the option levels (the
// trailing stop ratcheting, the close) is an option_plan_events row.
// ============================================================

import { createHash } from 'node:crypto';
import type { OptionCandidate, OptionChain, TradeSetup } from '@fno/shared';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { OPTION_SELECTION_VERSION } from '../config/trading-flags.js';

export const OPTION_PLANS_MIGRATION = '035_option_plans.sql';

export interface UnderlyingPlan {
  entry: number | null;
  stop: number | null;
  t1: number | null;
  t2: number | null;
}

export interface OptionLevels {
  entry: number | null;
  sl: number | null;
  /** The current trailing stop (the initial SL until it trails). */
  tsl: number | null;
  t1: number | null;
  t2: number | null;
}

export interface OptionPlanRow {
  planId: string;
  signalId: string | null;
  snapshotId: string | null;
  symbol: string;
  exchange: string;
  mode: string;
  source: string;
  candidateId: string | null;
  direction: string;
  underlying: UnderlyingPlan;
  option: { side: string | null; strike: number | null; expiry: string | null; token: string | null };
  levels: OptionLevels;
  selectedStrike: number | null;
  candidates: OptionCandidate[];
  rejectedStrikes: OptionCandidate[];
  optionSelectionVersion: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A UUID-shaped sha256 of the parts (deterministic ids for plans and events). */
export function hashUuid(...parts: Array<string | number | null>): string {
  const h = createHash('sha256').update(parts.map((p) => String(p)).join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/** One plan per minted trade: its id is derived from the trade's signal id. */
export const planIdFor = (signalId: string): string => hashUuid('option-plan', signalId);

/**
 * The option T2: the builder prices one target (T1). With an underlying T2
 * beyond T1, the extra move is projected onto the premium with the leg's
 * |delta| (the projection the setup watch uses). Null without a T2 or delta.
 */
export function optionT2(args: { t1Premium: number | null; delta: number | null; underlying: UnderlyingPlan; direction: string }): number | null {
  const { t1Premium, delta, underlying, direction } = args;
  if (t1Premium == null || delta == null || !Number.isFinite(delta) || underlying.t1 == null || underlying.t2 == null) return null;
  const extra = direction === 'BEARISH' ? underlying.t1 - underlying.t2 : underlying.t2 - underlying.t1;
  return extra > 0 ? r2(t1Premium + Math.abs(delta) * extra) : null;
}

/** The levels of a (stored) setup. */
export function optionLevelsOf(setup: Pick<TradeSetup, 'entry' | 'stopLoss' | 'target' | 'initialStopLoss'>, t2: number | null): OptionLevels {
  return { entry: setup.entry ?? null, sl: setup.initialStopLoss ?? setup.stopLoss ?? null, tsl: setup.stopLoss ?? null, t1: setup.target ?? null, t2 };
}

/** Pure: the plan row of a minted setup. */
export function buildOptionPlanRow(args: {
  signalId: string;
  snapshotId: string | null;
  symbol: string;
  exchange: string;
  mode: string;
  source: string;
  candidateId: string | null;
  direction: string;
  underlying: UnderlyingPlan;
  setup: TradeSetup;
  chain: Pick<OptionChain, 'strikes' | 'expiry'>;
}): OptionPlanRow {
  const { setup, chain } = args;
  const row = setup.strike != null ? chain.strikes.find((s) => s.strike === setup.strike) : null;
  const leg = row ? (setup.side === 'PE' ? row.put : row.call) : null;
  const sel = setup.fnoValidation?.strikeSelection ?? null;
  const delta = sel?.delta ?? leg?.delta ?? null;
  const candidates: OptionCandidate[] = sel?.optionCandidates ?? [];
  const t2 = optionT2({ t1Premium: setup.target ?? null, delta, underlying: args.underlying, direction: args.direction });
  return {
    planId: planIdFor(args.signalId),
    signalId: args.signalId,
    snapshotId: args.snapshotId,
    symbol: args.symbol,
    exchange: args.exchange,
    mode: args.mode,
    source: args.source,
    candidateId: args.candidateId,
    direction: args.direction,
    underlying: args.underlying,
    option: { side: setup.side ?? null, strike: setup.strike ?? null, expiry: setup.expiry ?? chain.expiry ?? null, token: leg?.token ?? null },
    levels: optionLevelsOf({ ...setup, initialStopLoss: setup.stopLoss }, t2),
    selectedStrike: sel?.selectedStrike ?? setup.strike ?? null,
    candidates,
    rejectedStrikes: candidates.filter((c) => c.status === 'REJECTED'),
    optionSelectionVersion: OPTION_SELECTION_VERSION,
  };
}

export type OptionPlanEventType = 'CREATED' | 'TSL_MOVED' | 'CLOSED';

export const optionPlansReady = (): boolean => schemaFileReady(OPTION_PLANS_MIGRATION);

/** Inserts the plan and its CREATED event. Never throws (a plan write must not fail a mint). */
export async function persistOptionPlan(row: OptionPlanRow, at: number): Promise<void> {
  if (!optionPlansReady()) return;
  try {
    await sql`
      INSERT INTO option_plans (
        plan_id, signal_id, snapshot_id, symbol, exchange, mode, source, candidate_id, direction,
        underlying_entry, underlying_stop, underlying_t1, underlying_t2,
        option_side, option_strike, option_expiry, option_token,
        option_entry, option_sl, option_tsl, option_t1, option_t2,
        selected_strike, candidates, rejected_strikes, option_selection_version
      ) VALUES (
        ${row.planId}, ${row.signalId}, ${row.snapshotId}, ${row.symbol}, ${row.exchange}, ${row.mode}, ${row.source}, ${row.candidateId}, ${row.direction},
        ${row.underlying.entry}, ${row.underlying.stop}, ${row.underlying.t1}, ${row.underlying.t2},
        ${row.option.side}, ${row.option.strike}, ${row.option.expiry}, ${row.option.token},
        ${row.levels.entry}, ${row.levels.sl}, ${row.levels.tsl}, ${row.levels.t1}, ${row.levels.t2},
        ${row.selectedStrike}, ${sql.json(row.candidates as never)}, ${sql.json(row.rejectedStrikes as never)}, ${row.optionSelectionVersion}
      )
      ON CONFLICT (plan_id) DO NOTHING
    `;
  } catch (err: any) {
    logger.error({ error: err.message, planId: row.planId, signalId: row.signalId }, 'option_plans: insert failed');
    return;
  }
  await recordOptionPlanEvent({ planId: row.planId, at, type: 'CREATED', before: null, after: row.levels, reason: 'Plan at the mint.', snapshotId: row.snapshotId });
}

/** Appends one change of the option levels. Never throws. */
export async function recordOptionPlanEvent(e: { planId: string; at: number; type: OptionPlanEventType; before: OptionLevels | null; after: OptionLevels; reason: string | null; snapshotId?: string | null }): Promise<void> {
  if (!optionPlansReady()) return;
  try {
    await sql`
      INSERT INTO option_plan_events (event_id, plan_id, at, event_type, levels_before, levels_after, reason, snapshot_id)
      VALUES (${hashUuid('option-plan-event', e.planId, e.type, e.at, JSON.stringify(e.after))}, ${e.planId}, ${new Date(e.at).toISOString()}, ${e.type},
              ${e.before ? sql.json(e.before as never) : null}, ${sql.json(e.after as never)}, ${e.reason}, ${e.snapshotId ?? null})
      ON CONFLICT (event_id) DO NOTHING
    `;
  } catch (err: any) {
    logger.error({ error: err.message, planId: e.planId, type: e.type }, 'option_plan_events: insert failed');
  }
}
