// ============================================================
// ISOLATED PAPER EXPERIMENTS — engine (EXP-2.0, 2026-10-23)
// ============================================================
// Wiring for experiment-arms.ts. Inputs, all reused, none new:
//   - the production poll: every Old Indicator read of a symbol+mode calls
//     onIndicatorPoll (fire-and-forget) with the poll's own chain, its bias
//     read, its newest closed 15m bar and a side-effect-free candidate builder;
//   - the shared tick feed (SubscriptionManager, client 'experiment-engine'):
//     open experiment contracts are subscribed on the same WebSocket;
//   - a 60 s timer for session ends.
// Outputs: experiment_* tables only (migration 045). The production baseline
// never reads them. Flag EXPERIMENT_ARMS (default on) switches it all off.
// ============================================================

import { randomUUID } from 'node:crypto';
import { FO_SEGMENT, isMarketOpen, minutesSinceSessionOpen } from '@fno/shared';
import { MIN_CONFIDENCE } from '@fno/analytics';
import type { Exchange, OptionChain, Tick, TradingMode } from '@fno/shared';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { sessionEndExitTime } from './validation-gates.js';
import type { SubscriptionManager } from '../lib/subscription-manager.js';
import { observeChainLeg, observeTick, type QuoteObservation } from './paper-execution-ledger.js';
import {
  ARMS,
  EXPERIMENTS_VERSION,
  armEntryDecision,
  isLive,
  lossOf,
  onDecisionRead,
  onQuote,
  onSessionEnd,
  openPosition,
  type ArmDef,
  type ArmLoss,
  type ArmPosition,
  type ExpCandidate,
  type ExpQuote,
} from './experiment-arms.js';

export const EXPERIMENTS_MIGRATION = '045_experiments_and_linkage.sql';
export const EXPERIMENT_ARMS_ENABLED = (process.env.EXPERIMENT_ARMS ?? 'on').toLowerCase() !== 'off';
const CLIENT_ID = 'experiment-engine';
const TICK_MS = 60_000;

const positions = new Map<string, ArmPosition>();
const losses = new Map<string, ArmLoss[]>(); // arm -> its own official stop-outs (cooldown state)
const decided = new Set<string>(); // de-dupe SKIP rows: arm|candidate|code
let subs: SubscriptionManager | null = null;
let started = false;
const istDay = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export const toExpQuote = (o: QuoteObservation): ExpQuote => ({
  ltp: o.ltp, bid: o.bid, ask: o.ask, bidQty: o.bidQty, askQty: o.askQty, exchangeAt: o.exchangeAt, receivedAt: o.receivedAt, feedState: o.feedState, source: o.source,
});

const ready = () => schemaFileReady(EXPERIMENTS_MIGRATION);

async function persist(p: ArmPosition, events: string[], at: number): Promise<void> {
  if (!ready()) return;
  await sql`
    INSERT INTO experiment_positions (id, arm, arm_version, candidate_id, symbol, exchange, mode, direction, opened_at, official_status, sim_status, official_net_r, sim_net_r, state, updated_at)
    VALUES (${p.id}, ${p.arm}, ${p.armVersion}, ${p.candidate.candidateId}, ${p.candidate.symbol}, ${p.candidate.exchange}, ${p.candidate.mode}, ${p.candidate.direction},
      ${new Date(p.openedAt)}, ${p.official.status}, ${p.sim.status}, ${p.official.netR}, ${p.sim.netR}, ${sql.json(p as any)}, NOW())
    ON CONFLICT (id) DO UPDATE SET official_status = EXCLUDED.official_status, sim_status = EXCLUDED.sim_status, official_net_r = EXCLUDED.official_net_r,
      sim_net_r = EXCLUDED.sim_net_r, state = EXCLUDED.state, updated_at = NOW()
  `;
  for (const e of events) {
    await sql`INSERT INTO experiment_events (position_id, at, event, detail) VALUES (${p.id}, ${new Date(at)}, ${e}, ${sql.json({ official: p.official, sim: p.sim, stop: p.stop, quote: p.lastQuote } as any)})`;
  }
}

function save(p: ArmPosition, events: string[], at: number): void {
  if (events.length === 0 && p.observations % 10 !== 0) return; // a quote that changed nothing is persisted every 10th time
  void persist(p, events, at).catch((err: any) => logger.warn({ error: err?.message, id: p.id }, 'Experiments: persist failed (paper research only)'));
  const day = istDay(at);
  const l = lossOf(p, day);
  if (l && events.some((e) => e === 'OFFICIAL_STOP_LOSS')) losses.set(p.arm, [...(losses.get(p.arm) ?? []).filter((x) => at - x.at < 36 * 3600_000), l]);
  if (!isLive(p)) {
    positions.delete(p.id);
    if (p.candidate.token && subs && ![...positions.values()].some((o) => o.candidate.token === p.candidate.token)) {
      subs.unsubscribe(CLIENT_ID, [{ token: p.candidate.token, exchange: p.candidate.exchange as Exchange, exchangeSegment: FO_SEGMENT[p.candidate.exchange as Exchange] }]);
    }
  }
}

function recordDecision(arm: ArmDef, c: ExpCandidate, take: boolean, code: string | null, at: number): void {
  if (!ready()) return;
  const k = `${arm.id}|${c.candidateId}|${code}`;
  if (!take && decided.has(k)) return;
  decided.add(k);
  if (decided.size > 50_000) decided.clear();
  void sql`
    INSERT INTO experiment_decisions (at, arm, arm_version, candidate_id, symbol, exchange, mode, decision, code, detail)
    VALUES (${new Date(at)}, ${arm.id}, ${arm.version}, ${c.candidateId}, ${c.symbol}, ${c.exchange}, ${c.mode}, ${take ? 'TAKE' : 'SKIP'}, ${code},
      ${sql.json({ entry: c.entry, stop: c.stop, target: c.target, strike: c.strike, side: c.side, expiry: c.expiry, minutesSinceOpen: c.minutesSinceOpen } as any)})
    ON CONFLICT DO NOTHING
  `.catch((err: any) => logger.warn({ error: err?.message }, 'Experiments: decision record failed'));
}

export interface IndicatorPoll {
  at: number;
  symbol: string;
  exchange: Exchange;
  mode: TradingMode;
  direction: string;
  confidence: number;
  chain: OptionChain;
  confirmMs: number;
  lastClosedBar: { close: number; closeAt: number } | null;
  /** market-bias's side-effect-free Old Indicator candidate builder (null when it refuses). */
  buildCandidate: () => Promise<ExpCandidate | null>;
}

/** Called by every production poll of a symbol+mode. Never throws, never awaited by the poll. */
export async function onIndicatorPoll(poll: IndicatorPoll): Promise<void> {
  if (!EXPERIMENT_ARMS_ENABLED || !started || !ready()) return;
  try {
    // 1. Existing positions on this symbol+mode: the poll's own chain quote, then its bias read.
    for (const p of [...positions.values()]) {
      if (p.candidate.symbol !== poll.symbol || p.candidate.exchange !== poll.exchange || p.candidate.mode !== poll.mode) continue;
      const arm = ARMS.find((a) => a.id === p.arm)!;
      const q = observeChainLeg(poll.chain, p.candidate.strike, p.candidate.side, p.candidate.expiry, poll.at);
      const ev = q.ltp != null || q.bid != null ? onQuote(p, toExpQuote(q), poll.at) : [];
      ev.push(...onDecisionRead(p, arm, { at: poll.at, direction: poll.direction, confidence: poll.confidence, minConfidence: MIN_CONFIDENCE, confirmMs: poll.confirmMs, lastClosedBar: poll.lastClosedBar }));
      save(p, ev, poll.at);
    }
    // 2. A new candidate, only when some arm could take one (free slot) — never otherwise built.
    if (poll.mode !== 'INTRADAY' || (poll.direction !== 'BULLISH' && poll.direction !== 'BEARISH')) return;
    const slotHeld = (arm: ArmDef) => [...positions.values()].some((p) => p.arm === arm.id && p.official.status === 'OPEN' && p.candidate.symbol === poll.symbol && p.candidate.exchange === poll.exchange && p.candidate.mode === poll.mode);
    if (ARMS.every(slotHeld)) return;
    const c = await poll.buildCandidate();
    if (!c) return;
    const day = istDay(poll.at);
    for (const arm of ARMS) {
      const d = armEntryDecision(arm, c, slotHeld(arm), losses.get(arm.id) ?? [], poll.at, day);
      recordDecision(arm, c, d.take, d.code, poll.at);
      if (!d.take) continue;
      const p = openPosition(arm, c, randomUUID(), poll.at);
      positions.set(p.id, p);
      save(p, ['OPENED', p.sim.status === 'NOT_OPENED' ? 'SIM_ENTRY_UNAVAILABLE' : 'SIM_ENTRY_FILLED'], poll.at);
      if (c.token && subs) {
        void subs.subscribe(CLIENT_ID, [{ token: c.token, exchange: c.exchange as Exchange, exchangeSegment: FO_SEGMENT[c.exchange as Exchange] }]).catch(() => undefined);
      }
    }
  } catch (err: any) {
    logger.warn({ error: err?.message, symbol: poll.symbol }, 'Experiments: poll hook failed (paper research only; production unaffected)');
  }
}

function onTicks(ticks: Tick[]): void {
  for (const t of ticks) {
    for (const p of positions.values()) {
      if (p.candidate.token !== t.token) continue;
      try {
        const q = toExpQuote(observeTick(t, subs?.feedStateOfToken(t.token) ?? null));
        save(p, onQuote(p, q, t.timestamp), t.timestamp);
      } catch {
        /* never disturbs the feed */
      }
    }
  }
}

function tick(): void {
  const now = Date.now();
  for (const p of [...positions.values()]) {
    if (p.candidate.mode !== 'INTRADAY') continue;
    const ex = p.candidate.exchange as Exchange;
    const sameDay = istDay(p.openedAt) === istDay(now);
    if ((sameDay && minutesSinceSessionOpen(ex, now) == null && !isMarketOpen(ex, now)) || !sameDay) {
      const closeAt = sessionEndExitTime(ex, p.openedAt, now);
      save(p, onSessionEnd(p, closeAt), closeAt);
    }
  }
}

async function load(): Promise<void> {
  const rows = await sql<{ state: ArmPosition }[]>`SELECT state FROM experiment_positions WHERE official_status = 'OPEN' OR sim_status IN ('OPEN', 'EXIT_PENDING')`;
  for (const r of rows) positions.set(r.state.id, r.state);
  const recent = await sql<{ state: ArmPosition }[]>`SELECT state FROM experiment_positions WHERE updated_at > NOW() - INTERVAL '36 hours' AND official_status = 'CLOSED'`;
  for (const r of recent) {
    const l = lossOf(r.state, istDay(r.state.official.exitAt ?? r.state.openedAt));
    if (l) losses.set(r.state.arm, [...(losses.get(r.state.arm) ?? []), l]);
  }
  for (const arm of ARMS) {
    await sql`
      INSERT INTO experiment_arms (arm, version, kind, exploratory, definition, commit)
      VALUES (${arm.id}, ${arm.version}, ${arm.kind}, ${arm.exploratory}, ${sql.json({ description: arm.description, invalidationExit: arm.invalidationExit, engine: EXPERIMENTS_VERSION } as any)}, ${process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null})
      ON CONFLICT (arm, version) DO NOTHING
    `;
  }
}

/** Supervised start (index.ts). */
export function startExperimentEngine(subscriptions?: SubscriptionManager): void {
  if (started) return;
  if (!EXPERIMENT_ARMS_ENABLED) {
    logger.info('Experiments: EXPERIMENT_ARMS=off — no experiment arm runs');
    return;
  }
  subs = subscriptions ?? null;
  subs?.onTick(onTicks);
  setInterval(tick, TICK_MS);
  void (async () => {
    if (!ready()) {
      logger.warn('Experiments: migration 045 not applied — engine idle');
      return;
    }
    await load();
    started = true;
    const tokens = [...new Set([...positions.values()].map((p) => p.candidate.token).filter((t): t is string => !!t))];
    for (const t of tokens) {
      const p = [...positions.values()].find((x) => x.candidate.token === t)!;
      void subs?.subscribe(CLIENT_ID, [{ token: t, exchange: p.candidate.exchange as Exchange, exchangeSegment: FO_SEGMENT[p.candidate.exchange as Exchange] }]).catch(() => undefined);
    }
    logger.info({ arms: ARMS.map((a) => a.version), openPositions: positions.size }, 'Experiments: engine started (isolated paper arms; production baseline unaffected)');
  })().catch((err: any) => logger.warn({ error: err?.message }, 'Experiments: start failed — engine idle'));
}

/** Tests only. */
export function __resetExperimentEngine(): void {
  positions.clear();
  losses.clear();
  decided.clear();
  started = false;
  subs = null;
}
export function __startedForTest(): void {
  started = true;
}
export function __positions(): ArmPosition[] {
  return [...positions.values()];
}
