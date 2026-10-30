import { reconcileRetiredLegacySlots } from './fresh-start/legacy-reset.js';
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
//
// 2026-10-09 (a trade must never be revived or lost):
//   * queued closes (pending-outcomes.ts) are applied FIRST, so a trade whose
//     close failed to write during an outage is closed, not revived;
//   * an open row that a LATER trade on the same slot has superseded is never
//     written back — its tracking was lost; it is closed TRACKING_LOST and
//     voided (excluded from every statistic: its real exit is unknown);
//   * an INTRADAY open row from an earlier session that no slot tracks is
//     closed TRACKING_LOST the same way (sweepLostTrades, also run by the
//     price monitor periodically).
// 2026-10-18 (audit LIFE-1): the sweep covers every mode — also a superseded
// row that is not the newest on its slot, and a row whose option expired —
// and a lost row whose option plan recorded a close gets that close instead
// of a void.
// ============================================================

import type { SetupWatchRow } from '@fno/shared';
import { sql } from '../lib/db.js';
import { redis, scanKeys } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { canonicalJson } from './decision-record.js';
import { drainPendingOutcomes } from './pending-outcomes.js';
import { delSlotIfSame, slotIdentity } from '../lib/slot-cas.js';

const istDate = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** Pure: an open row is superseded when a later trade exists on the same slot (symbol, exchange, mode). */
export function isSuperseded(row: { id: string; time: Date | string }, laterOnSlot: ReadonlyArray<{ id: string; time: Date | string }>): boolean {
  const t = new Date(row.time).getTime();
  return laterOnSlot.some((o) => o.id !== row.id && new Date(o.time).getTime() > t);
}

/** Close lost trades (open rows no slot tracks) as TRACKING_LOST, voided — their real exit is unknown. */
export async function voidLostTrades(ids: readonly string[], why: string): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await sql<{ id: string }[]>`
    UPDATE signals SET inputs = inputs || ${sql.json({ outcome: 'EXPIRED', closeReason: 'TRACKING_LOST', exitPrice: null, voided: true, voidReason: `TRACKING_LOST: ${why}` } as any)}
    WHERE id = ANY(${ids as string[]}) AND (inputs->>'outcome') IS NULL
    RETURNING id
  `;
  if (rows.length) logger.warn({ ids: rows.map((r) => r.id), why }, 'Trade tracking lost — closed TRACKING_LOST (voided, excluded from statistics)');
  return rows.length;
}

export const LOST_EARLIER_SESSION = 'an intraday trade from an earlier session that no slot tracks';
export const LOST_SUPERSEDED = 'a later trade on the same slot superseded it while its close was never recorded';

export interface LostTradeCandidate {
  id: string;
  time: Date | string;
  symbol: string;
  exchange: string | null;
  mode: string;
  expiry: string | null;
}

/**
 * Pure (audit 2026-10-18, LIFE-1): the open rows no trade_setup slot holds that nothing will ever close at a real
 * price, in EVERY mode: an intraday row from an earlier session, a row a later trade on the same slot (exchange,
 * symbol, mode) superseded, or a row whose option has expired. Only intraday rows were swept before, so a superseded
 * POSITIONAL trade (e41a6899, CRUDEOIL PE 8950) stayed open past its expiry. A held row is never touched.
 */
export function lostTradeVerdicts(args: { open: readonly LostTradeCandidate[]; trades: readonly LostTradeCandidate[]; held: ReadonlySet<string>; today: string }): Array<{ id: string; why: string }> {
  const out: Array<{ id: string; why: string }> = [];
  for (const r of args.open) {
    if (args.held.has(r.id)) continue;
    const sameSlot = args.trades.filter((o) => o.symbol === r.symbol && o.exchange === r.exchange && o.mode === r.mode);
    if (r.mode === 'INTRADAY' && istDate(new Date(r.time).getTime()) !== args.today) out.push({ id: r.id, why: LOST_EARLIER_SESSION });
    else if (isSuperseded(r, sameSlot)) out.push({ id: r.id, why: LOST_SUPERSEDED });
    else if (isPastExpiry(r.expiry, args.today)) out.push({ id: r.id, why: `its option expired on ${r.expiry} and no slot can price it` });
  }
  return out;
}

/** Pure: the close an option plan's CLOSED event recorded ("WIN (TARGET) at 328.4"); null without a price or when it does not parse. */
export function planCloseOf(reason: string | null | undefined): { outcome: 'WIN' | 'LOSS' | 'EXPIRED'; closeReason: string; exitPrice: number } | null {
  const m = /^(WIN|LOSS|EXPIRED) \(([A-Z0-9_]+)\) at (-?\d+(?:\.\d+)?)$/.exec(reason?.trim() ?? '');
  if (!m) return null;
  const exitPrice = Number(m[3]);
  return Number.isFinite(exitPrice) ? { outcome: m[1] as 'WIN' | 'LOSS' | 'EXPIRED', closeReason: m[2], exitPrice } : null;
}

/**
 * A lost row whose option plan DID record a close (the plan event was written, the trade row was not — 8 Oct) gets
 * that close, its FIRST CLOSED event (the monitor's own exit; a later one came from a revival), instead of a void.
 * Only an open row is written. Returns the ids recovered.
 */
async function recoverRecordedCloses(ids: readonly string[]): Promise<Set<string>> {
  const done = new Set<string>();
  if (ids.length === 0 || !schemaFileReady('035_option_plans.sql')) return done;
  const rows = await sql<{ signal_id: string; reason: string | null; at: Date; minted: Date }[]>`
    SELECT DISTINCT ON (p.signal_id) p.signal_id, e.reason, e.at, s.time AS minted
    FROM option_plans p JOIN option_plan_events e ON e.plan_id = p.plan_id JOIN signals s ON s.id = p.signal_id
    WHERE p.signal_id = ANY(${ids as string[]}) AND e.event_type = 'CLOSED'
    ORDER BY p.signal_id, e.at ASC
  `;
  for (const r of rows) {
    const close = planCloseOf(r.reason);
    if (!close) continue;
    const exitTime = new Date(r.at).getTime();
    const patch = { ...close, exitTime, holdMinutes: Math.round((exitTime - new Date(r.minted).getTime()) / 60000), recoveredFrom: 'OPTION_PLAN_CLOSED_EVENT' };
    const updated = await sql<{ id: string }[]>`
      UPDATE signals SET inputs = inputs || ${sql.json(patch as any)}
      WHERE id = ${r.signal_id} AND (inputs->>'outcome') IS NULL
      RETURNING id
    `;
    if (updated.length) {
      done.add(r.signal_id);
      logger.warn({ id: r.signal_id, close: r.reason }, 'Lost trade: its plan recorded a close the trade row never got — applied that close');
    }
  }
  return done;
}

/** Close lost rows: the recorded close when the plan has one, else TRACKING_LOST (voided). */
async function closeLostTrades(lost: ReadonlyArray<{ id: string; why: string }>): Promise<number> {
  if (lost.length === 0) return 0;
  const recovered = await recoverRecordedCloses(lost.map((l) => l.id));
  let n = recovered.size;
  const byWhy = new Map<string, string[]>();
  for (const l of lost) if (!recovered.has(l.id)) byWhy.set(l.why, [...(byWhy.get(l.why) ?? []), l.id]);
  for (const [why, ids] of byWhy) n += await voidLostTrades(ids, why);
  return n;
}

/** Pure: the option of this row has expired (an ISO expiry date before today, IST). */
export function isPastExpiry(expiry: string | null | undefined, today: string): boolean {
  return expiry != null && /^\d{4}-\d{2}-\d{2}$/.test(expiry) && expiry < today;
}

/** signalId → the trade_setup slot key that holds it. */
async function heldSlots(): Promise<Map<string, string>> {
  const held = new Map<string, string>();
  for (const k of await scanKeys('trade_setup:*')) {
    const raw = await redis.get(k);
    try {
      const v = raw ? JSON.parse(raw) : null;
      if (v?.signalId) held.set(v.signalId, k);
    } catch {
      /* unreadable slot: holds nothing we can match */
    }
  }
  return held;
}

/**
 * The open rows no trade_setup slot holds that nothing will ever close at a real price (lostTradeVerdicts), in every
 * mode. Run on boot and every 30 minutes by the price monitor.
 */
export async function sweepLostTrades(now = Date.now()): Promise<number> {
  const today = istDate(now);
  const open = await sql<LostTradeCandidate[]>`
    SELECT id, time, symbol, inputs->>'exchange' AS exchange, coalesce(inputs->>'mode', 'INTRADAY') AS mode, inputs->>'expiry' AS expiry FROM signals
    WHERE signal_type = 'TRADE_SETUP' AND (inputs->>'outcome') IS NULL AND time > NOW() - INTERVAL '35 days'
  `;
  if (open.length === 0) return 0;
  const slots = await heldSlots();
  // A slot holding a trade whose option has expired can never price it (the chain has moved to the next expiry) and
  // blocks the symbol: release it (only if it still holds that trade), and the row is lost like any other.
  for (const r of open) {
    const key = slots.get(r.id);
    if (key && isPastExpiry(r.expiry, today) && (await delSlotIfSame(key, slotIdentity({ signalId: r.id })))) {
      slots.delete(r.id);
      logger.warn({ key, id: r.id, expiry: r.expiry }, 'Lost-trade sweep: released a slot whose option has expired');
    }
  }
  const held = new Set(slots.keys());
  const unheld = open.filter((r) => !held.has(r.id));
  if (unheld.length === 0) return 0;
  const later = await sql<LostTradeCandidate[]>`
    SELECT id, time, symbol, inputs->>'exchange' AS exchange, coalesce(inputs->>'mode', 'INTRADAY') AS mode, inputs->>'expiry' AS expiry FROM signals
    WHERE signal_type = 'TRADE_SETUP' AND time > ${new Date(Math.min(...unheld.map((r) => new Date(r.time).getTime())))}
  `;
  return closeLostTrades(lostTradeVerdicts({ open: unheld, trades: later, held, today }));
}
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

  await step('retired_legacy_slots', async () => { await reconcileRetiredLegacySlots(); });

  // Queued closes first: a trade whose close failed to write must be closed, not revived.
  await step('pending_outcomes', async () => {
    await drainPendingOutcomes();
  });

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
    // A later trade on the same slot supersedes an open row: never revive it.
    const latestRows = [...latest.values()];
    const later = latestRows.length
      ? await sql<{ id: string; time: Date; symbol: string; exchange: string; mode: string }[]>`
          SELECT id, time, symbol, inputs->>'exchange' AS exchange, coalesce(inputs->>'mode', 'INTRADAY') AS mode FROM signals
          WHERE signal_type = 'TRADE_SETUP' AND time > ${new Date(Math.min(...latestRows.map((r) => new Date(r.time).getTime())))}
        `
      : [];
    const heldIds = new Set([...cached.values()].map((v) => v?.signalId).filter((x): x is string => typeof x === 'string'));
    const superseded: string[] = [];
    for (const [k, row] of [...latest]) {
      const mode = row.inputs?.mode ?? 'INTRADAY';
      const sameSlot = later.filter((o) => o.symbol === row.symbol && o.exchange === row.inputs?.exchange && o.mode === mode);
      if (!heldIds.has(row.id) && isSuperseded(row, sameSlot)) {
        superseded.push(row.id);
        latest.delete(k);
      }
    }
    await closeLostTrades(superseded.map((id) => ({ id, why: LOST_SUPERSEDED })));

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

  await step('lost_trades', async () => {
    await sweepLostTrades(now);
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
