// ============================================================
// STATE RECOVERY — PostgreSQL is the source of truth, Redis the cache (Phase 6)
// ============================================================
// On boot (before the trade-setup monitor starts) the Redis working state is
// rebuilt from PostgreSQL, and where the two disagree PostgreSQL wins:
//
//   trade_setup:*        the open paper trade per symbol / mode — signals rows
//                        (TRADE_SETUP, no outcome yet) + the trailing stop from
//                        option_plan_events. A Redis setup whose trade PG has
//                        closed is removed; one PG has no record of (signalId
//                        missing — its row failed to write) is kept, and the
//                        existing backfill records it.
//   structure_outcome:*  the live outcome of each structure lifecycle (minted /
//   structure_claimed:*  refused) and its claim — setup_lifecycle_events
//   structure_event:*    ENTRY_MINTED / ENTRY_REFUSED rows; the per-transition
//                        dedupe keys, so a rebuilt state never re-writes rows
//   slot_traded:*        today's traded parents — setup_events ARBITRATION rows
//                        of the minted candidates (union with Redis: never
//                        fewer blocks than either side knows)
//   setup_watch:*        today's watched setups — the latest setup_events
//                        LIFECYCLE row of each, which carries the whole row
//
// The tick-feed subscriptions of the monitor follow from trade_setup:* on its
// first sweep, which starts only after this ran (supervisor `ready`).
// Every lifecycle transition is already written to PostgreSQL (lifecycle rows,
// setup_events LIFECYCLE / ARBITRATION rows, signals, option_plan_events).
// The merge rules are pure; the IO is a thin shell.
// ============================================================

import type { SetupWatchRow } from '@fno/shared';
import { sql } from '../lib/db.js';
import { redis, scanKeys } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { canonicalJson } from './decision-record.js';

const istDate = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const INTRADAY_TTL = 60 * 60 * 24 * 2;
const POSITIONAL_TTL = 60 * 60 * 24 * 30;

// ---------------- pure rules ----------------

export interface OpenTradeRow {
  id: string;
  time: Date | string;
  symbol: string;
  direction: string;
  inputs: Record<string, any>;
  reasoning: string | null;
}

/** The fields PostgreSQL records for an open trade (what "disagree" is judged on). */
const PG_FIELDS = ['signalId', 'available', 'direction', 'side', 'strike', 'expiry', 'entry', 'target', 'structureType'] as const;

/** Pure: the sticky setup a PostgreSQL open-trade row stands for (trailing stop from the plan, when recorded). */
export function storedSetupFromSignal(row: OpenTradeRow, planTsl: number | null): Record<string, any> {
  const i = row.inputs ?? {};
  const generatedAt = new Date(row.time).getTime();
  const initial = typeof i.stopLoss === 'number' ? i.stopLoss : null;
  return {
    available: true,
    reason: row.reasoning ?? 'Rehydrated from PostgreSQL.',
    direction: row.direction,
    day: istDate(generatedAt),
    generatedAt,
    signalId: row.id,
    structureType: i.structureType ?? 'NAKED_LONG',
    side: i.side,
    strike: i.strike,
    entry: i.entry,
    stopLoss: planTsl != null && initial != null ? Math.max(planTsl, initial) : initial,
    initialStopLoss: initial,
    target: i.target,
    riskReward: i.riskReward,
    strategy: i.strategy,
    legs: i.legs,
    netPremium: i.netPremium,
    maxProfit: i.maxProfit,
    maxLoss: i.maxLoss,
    breakeven: i.breakeven,
    breakevenLower: i.breakevenLower,
    breakevenUpper: i.breakevenUpper,
    expiry: i.expiry ?? undefined,
    dte: i.dte ?? undefined,
    estimatedCostPct: i.estimatedCostPct ?? undefined,
    ...(i.fnoValidation ? { fnoValidation: i.fnoValidation } : {}),
    voteSnapshot: i.votes ?? undefined,
    entryContext: i.context ?? undefined,
    logic: i.logic ?? null,
    rehydratedFrom: 'POSTGRES',
  };
}

export type Reconcile = { action: 'KEEP'; reason: string } | { action: 'WRITE'; value: Record<string, any>; reason: string } | { action: 'DELETE'; reason: string };

/**
 * Pure: reconcile one trade_setup slot. `pg` = the latest open trade PG has
 * for it (null: none); `closedInPg` = signal ids PG has closed. PG wins on
 * every field it records; the trailing stop only when PG recorded one.
 */
export function reconcileTradeSetup(args: { pg: Record<string, any> | null; pgHasTsl: boolean; redis: Record<string, any> | null; closedInPg: ReadonlySet<string> }): Reconcile {
  const { pg, redis, closedInPg } = args;
  if (!pg) {
    if (redis?.available && redis.signalId && closedInPg.has(redis.signalId)) return { action: 'DELETE', reason: 'PostgreSQL has this trade closed.' };
    return { action: 'KEEP', reason: redis ? 'No open trade in PostgreSQL; nothing contradicts the cache.' : 'Nothing to rebuild.' };
  }
  if (!redis || !redis.available) return { action: 'WRITE', value: pg, reason: redis ? 'The cache holds no open trade; PostgreSQL has one.' : 'Missing in Redis.' };
  if (!redis.signalId) return { action: 'KEEP', reason: 'The cached trade has no PostgreSQL row yet (the backfill records it).' };
  if (redis.signalId !== pg.signalId) return { action: 'WRITE', value: pg, reason: `The cache holds ${redis.signalId}; PostgreSQL's open trade is ${pg.signalId}.` };
  // A setup minted without an explicit structureType is a naked long (the default every reader applies).
  const norm = (o: Record<string, any>, f: string) => (f === 'structureType' ? o[f] ?? 'NAKED_LONG' : o[f] ?? null);
  const diffs = PG_FIELDS.filter((f) => canonicalJson(norm(redis, f)) !== canonicalJson(norm(pg, f)));
  if (args.pgHasTsl && canonicalJson(redis.stopLoss) !== canonicalJson(pg.stopLoss)) diffs.push('stopLoss' as never);
  if (diffs.length === 0) return { action: 'KEEP', reason: 'Agrees with PostgreSQL.' };
  const merged = { ...redis };
  for (const f of diffs) merged[f] = pg[f];
  return { action: 'WRITE', value: merged, reason: `PostgreSQL wins on ${diffs.join(', ')}.` };
}

/** Pure: a structure lifecycle's live outcome from its ENTRY_MINTED / ENTRY_REFUSED row (reason "CODE: text"). */
export function outcomeFromLifecycleRow(row: { to_state: string; reason: string | null; time: Date | string; decision_id: string | null; signal_id: string | null }): { outcome: 'MINTED' | 'REFUSED'; reason: string | null; code: string | null; at: number; decisionId: string | null; signalId: string | null } {
  const m = row.reason ? /^([A-Z_]+): ?(.*)$/s.exec(row.reason) : null;
  return {
    outcome: row.to_state === 'ENTRY_MINTED' ? 'MINTED' : 'REFUSED',
    code: m ? m[1] : null,
    reason: m ? m[2] || null : row.reason,
    at: new Date(row.time).getTime(),
    decisionId: row.decision_id,
    signalId: row.signal_id,
  };
}

/** Pure: today's traded anchor keys per slot from the minted candidates' ARBITRATION rows. */
export function tradedKeysFromArbitration(rows: ReadonlyArray<{ exchange: string; instrument: string; context: any }>): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const a = r.context?.slotArbitration;
    if (!a) continue;
    const minted = a.slotDecision ? a.slotDecision.decision === 'MINTED' : a.role === 'SELECTED';
    if (!minted) continue;
    const k = `${r.exchange}:${r.instrument}`;
    const set = out.get(k) ?? new Set<string>();
    for (const key of a.anchorKeys ?? []) set.add(key);
    out.set(k, set);
  }
  return new Map([...out.entries()].map(([k, v]) => [k, [...v].sort()]));
}

/** Pure: merge the watch rows — PG's latest row wins where it exists; rows only Redis knows are kept. */
export function mergeWatchRows(pgRows: ReadonlyArray<SetupWatchRow>, redisRows: Record<string, SetupWatchRow>): { rows: Record<string, SetupWatchRow>; changed: string[] } {
  const rows: Record<string, SetupWatchRow> = { ...redisRows };
  const changed: string[] = [];
  for (const r of pgRows) {
    if (canonicalJson(rows[r.id] ?? null) !== canonicalJson(r)) {
      rows[r.id] = r;
      changed.push(r.id);
    }
  }
  return { rows, changed };
}

// ---------------- the boot rehydration ----------------

export interface RehydrationReport {
  tradeSetups: { written: number; deleted: number; kept: number };
  structureOutcomes: number;
  eventDedupeKeys: number;
  slotTraded: number;
  watchRows: number;
  errors: string[];
}

export async function rehydrateFromPostgres(now = Date.now()): Promise<RehydrationReport> {
  const report: RehydrationReport = { tradeSetups: { written: 0, deleted: 0, kept: 0 }, structureOutcomes: 0, eventDedupeKeys: 0, slotTraded: 0, watchRows: 0, errors: [] };
  const today = istDate(now);
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err: any) {
      report.errors.push(`${name}: ${err.message}`);
      logger.error({ error: err.message, step: name }, 'State recovery: step failed — that part of Redis is left as it was');
    }
  };

  await step('trade_setup', async () => {
    const open = await sql<OpenTradeRow[]>`
      SELECT id, time, symbol, direction, inputs, reasoning FROM signals
      WHERE signal_type = 'TRADE_SETUP' AND (inputs->>'outcome') IS NULL AND time > NOW() - INTERVAL '35 days'
      ORDER BY time DESC
    `;
    const latest = new Map<string, OpenTradeRow>();
    for (const r of open) {
      const mode = r.inputs?.mode ?? 'INTRADAY';
      if (mode === 'INTRADAY' && istDate(new Date(r.time).getTime()) !== today) continue;
      const k = `trade_setup:${r.inputs?.exchange}:${r.symbol}:${mode}`;
      if (!latest.has(k)) latest.set(k, r);
    }
    const tsl = new Map<string, number>();
    if (schemaFileReady('035_option_plans.sql') && latest.size > 0) {
      const ids = [...latest.values()].map((r) => r.id);
      const rows = await sql<{ signal_id: string; tsl: string | null }[]>`
        SELECT DISTINCT ON (p.signal_id) p.signal_id, e.levels_after->>'tsl' AS tsl
        FROM option_plans p JOIN option_plan_events e ON e.plan_id = p.plan_id
        WHERE p.signal_id = ANY(${ids}) ORDER BY p.signal_id, e.at DESC
      `;
      for (const r of rows) if (r.tsl != null && Number.isFinite(Number(r.tsl))) tsl.set(r.signal_id, Number(r.tsl));
    }
    const keys = new Set([...(await scanKeys('trade_setup:*')), ...latest.keys()]);
    const cached = new Map<string, Record<string, any> | null>();
    for (const k of keys) {
      const raw = await redis.get(k);
      cached.set(k, raw ? JSON.parse(raw) : null);
    }
    const cachedIds = [...cached.values()].map((v) => v?.signalId).filter((x): x is string => typeof x === 'string');
    const closed = new Set<string>(
      cachedIds.length === 0
        ? []
        : (await sql<{ id: string }[]>`SELECT id FROM signals WHERE id = ANY(${cachedIds}) AND (inputs->>'outcome') IS NOT NULL`).map((r) => r.id)
    );
    for (const k of keys) {
      const row = latest.get(k) ?? null;
      const pg = row ? storedSetupFromSignal(row, tsl.get(row.id) ?? null) : null;
      const r = reconcileTradeSetup({ pg, pgHasTsl: row != null && tsl.has(row.id), redis: cached.get(k) ?? null, closedInPg: closed });
      if (r.action === 'KEEP') {
        report.tradeSetups.kept++;
        continue;
      }
      logger.warn({ key: k, action: r.action, reason: r.reason }, 'State recovery: trade_setup reconciled from PostgreSQL');
      if (r.action === 'DELETE') {
        await redis.del(k);
        report.tradeSetups.deleted++;
      } else {
        await redis.set(k, JSON.stringify(r.value), 'EX', k.endsWith(':POSITIONAL') ? POSITIONAL_TTL : INTRADAY_TTL);
        report.tradeSetups.written++;
      }
    }
  });

  await step('structure_outcome', async () => {
    const rows = await sql<{ lifecycle_id: string; to_state: string; reason: string | null; time: Date; decision_id: string | null; signal_id: string | null }[]>`
      SELECT DISTINCT ON (lifecycle_id) lifecycle_id, to_state, reason, time, decision_id, signal_id FROM setup_lifecycle_events
      WHERE to_state IN ('ENTRY_MINTED', 'ENTRY_REFUSED') AND time > NOW() - INTERVAL '36 hours'
      ORDER BY lifecycle_id, time DESC
    `;
    for (const r of rows) {
      const want = outcomeFromLifecycleRow(r);
      const raw = await redis.get(`structure_outcome:${r.lifecycle_id}`);
      const have = raw ? JSON.parse(raw) : null;
      if (!have || have.outcome !== want.outcome || (have.code ?? null) !== want.code) {
        await redis.set(`structure_outcome:${r.lifecycle_id}`, JSON.stringify(want), 'EX', 60 * 60 * 36);
        report.structureOutcomes++;
      }
      await redis.set(`structure_claimed:${r.lifecycle_id}`, '1', 'EX', 60 * 60 * 24, 'NX');
    }
    const seen = await sql<{ lifecycle_id: string; to_state: string }[]>`
      SELECT DISTINCT lifecycle_id, to_state FROM setup_lifecycle_events WHERE time > NOW() - INTERVAL '3 days'
    `;
    for (const r of seen) {
      if ((await redis.set(`structure_event:${r.lifecycle_id}:${r.to_state}`, '1', 'EX', 3 * 24 * 60 * 60, 'NX')) === 'OK') report.eventDedupeKeys++;
    }
  });

  await step('slot_traded', async () => {
    const rows = await sql<{ exchange: string; instrument: string; context: any }[]>`
      SELECT exchange, instrument, context FROM setup_events
      WHERE event_type = 'ARBITRATION' AND time >= ${new Date(`${today}T00:00:00+05:30`)}
    `;
    for (const [slot, keys] of tradedKeysFromArbitration(rows)) {
      const [exchange, instrument] = slot.split(':');
      const key = `slot_traded:${exchange}:${instrument}:INTRADAY:${today}`;
      const have = JSON.parse((await redis.get(key)) ?? '[]') as string[];
      const union = [...new Set([...have, ...keys])].sort();
      if (union.length !== have.length) {
        await redis.set(key, JSON.stringify(union), 'EX', 36 * 60 * 60);
        report.slotTraded++;
      }
    }
  });

  await step('setup_watch', async () => {
    const rows = await sql<{ exchange: string; instrument: string; row: SetupWatchRow }[]>`
      SELECT DISTINCT ON (exchange, instrument, lifecycle_id) exchange, instrument, context->'watch'->'row' AS row FROM setup_events
      WHERE decision = 'LIFECYCLE' AND time >= ${new Date(`${today}T00:00:00+05:30`)} AND context->'watch'->'row' IS NOT NULL
      ORDER BY exchange, instrument, lifecycle_id, time DESC
    `;
    const bySlot = new Map<string, SetupWatchRow[]>();
    for (const r of rows) bySlot.set(`${r.exchange}:${r.instrument}`, [...(bySlot.get(`${r.exchange}:${r.instrument}`) ?? []), r.row]);
    for (const [slot, pgRows] of bySlot) {
      const [exchange, instrument] = slot.split(':');
      const key = `setup_watch:${exchange}:${instrument}:INTRADAY:${today}`;
      const { rows: merged, changed } = mergeWatchRows(pgRows, JSON.parse((await redis.get(key)) ?? '{}'));
      if (changed.length > 0) {
        await redis.set(key, JSON.stringify(merged), 'EX', 36 * 60 * 60);
        report.watchRows += changed.length;
      }
    }
  });

  logger.info(report, 'State recovery: Redis rebuilt from PostgreSQL');
  return report;
}
