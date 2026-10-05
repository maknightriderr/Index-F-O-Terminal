// ============================================================
// FULL REPLAY — the whole decision path of a snapshotted poll
// ============================================================
// replayFull(snapshotId) re-runs the unchanged buildMarketBias — the
// indicator engine, every safety gate, the option builds and strike
// ranking, the slot arbitration and the settlement (mint / NO TRADE /
// lifecycle writes) — at the poll's own instant, with Redis, SQL, the broker
// and in-process state served ONLY from the poll's tape (io-tape.ts):
//   * no network, no writes (writes are collected as effects);
//   * a read the tape does not hold is a divergence, never current data.
// It then compares the result with the one the live poll returned, and the
// writes it would have made with the writes the live poll made.
// ============================================================

import type { Exchange, TradingMode } from '@fno/shared';
import { replayProvider, runReplay, type TapeEffect } from '../lib/io-tape.js';
import { withDecisionTime } from './decision-clock.js';
import { canonicalJson } from './decision-record.js';
import { loadSnapshot, loadTape } from './decision-record-store.js';

/**
 * Fields stamped from the wall clock or a random id (not from the decision
 * instant): the ONE list excluded from the full-replay comparison.
 */
export const FULL_REPLAY_VOLATILE_KEYS = ['generatedAt', 'decisionId', 'signalId', 'timestamp', 'fetchedAt', 'computedAt', 'lastUpdated'] as const;

export function stripVolatile(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripVolatile);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!(FULL_REPLAY_VOLATILE_KEYS as readonly string[]).includes(k)) out[k] = stripVolatile(x);
    return out;
  }
  return v;
}

/** Paths at which two results differ outside the volatile keys. */
export function resultDiff(a: unknown, b: unknown, path = ''): string[] {
  const ca = canonicalJson(stripVolatile(a));
  const cb = canonicalJson(stripVolatile(b));
  if (ca === cb) return [];
  const oa = JSON.parse(ca);
  const ob = JSON.parse(cb);
  if (oa && ob && typeof oa === 'object' && typeof ob === 'object' && Array.isArray(oa) === Array.isArray(ob)) {
    const out: string[] = [];
    for (const k of [...new Set([...Object.keys(oa), ...Object.keys(ob)])].sort()) {
      out.push(...resultDiff(oa[k], ob[k], path ? `${path}.${k}` : k));
      if (out.length >= 50) break;
    }
    return out;
  }
  return [path || '(root)'];
}

/** Multiset difference of write targets (live vs replay). */
export function effectsDiff(live: readonly string[], replay: readonly string[]): { onlyLive: string[]; onlyReplay: string[] } {
  const count = (xs: readonly string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const l = count(live);
  const r = count(replay);
  const onlyLive: string[] = [];
  const onlyReplay: string[] = [];
  for (const [k, n] of l) for (let i = 0; i < n - (r.get(k) ?? 0); i++) onlyLive.push(k);
  for (const [k, n] of r) for (let i = 0; i < n - (l.get(k) ?? 0); i++) onlyReplay.push(k);
  return { onlyLive: onlyLive.sort(), onlyReplay: onlyReplay.sort() };
}

export interface FullReplayReport {
  snapshotId: string;
  status: 'MATCH' | 'DIFFERENT' | 'DIVERGED' | 'NO_TAPE' | 'NOT_FOUND';
  /** Result paths that differ (outside FULL_REPLAY_VOLATILE_KEYS). */
  diff: string[];
  /** Reads the tape did not hold — never answered with current data. */
  divergences: string[];
  error: string | null;
  effects: { live: number; replay: number; onlyLive: string[]; onlyReplay: string[] };
  /** What the replay decided (trade or NO TRADE, and why). */
  replayed: { available: boolean | null; noTradeCode: string | null; strategy: string | null; strike: number | null; limitingFactor: string | null };
}

/** The broker name the poll used, from the snapshot's recorded sources. */
const providerNameOf = (source: string | undefined) => (source ?? 'provider:').split(':')[0] || 'provider';

/** Full replay of one snapshot, compared with what the live poll did. Reads only the snapshot and its tape from the database. */
export async function replayFull(snapshotId: string, deps?: { buildMarketBias?: (p: any, u: string, e: Exchange, m: TradingMode) => Promise<any> }): Promise<FullReplayReport> {
  const empty = { diff: [], divergences: [], error: null, effects: { live: 0, replay: 0, onlyLive: [], onlyReplay: [] }, replayed: { available: null, noTradeCode: null, strategy: null, strike: null, limitingFactor: null } };
  const snap = await loadSnapshot(snapshotId);
  if (!snap) return { snapshotId, status: 'NOT_FOUND', ...empty };
  const stored = await loadTape(snapshotId);
  if (!stored) return { snapshotId, status: 'NO_TAPE', ...empty };
  const build = deps?.buildMarketBias ?? (await import('./market-bias.js')).buildMarketBias;
  const provider = replayProvider(providerNameOf(snap.dataQuality.inputs.ohlcv15m.source));
  const out = await runReplay(stored.tape, () => withDecisionTime(snap.polledAt, () => build(provider, snap.symbol, snap.exchange, snap.mode)), { now: snap.polledAt });
  const liveWrites = stored.tape.filter((e) => e.write).map(targetOf);
  const replayWrites = out.effects.map((e: TapeEffect) => `${e.ch}:${e.target}`);
  const diff = out.result == null ? ['(no result)'] : resultDiff((stored.liveResult as any) ?? null, out.result);
  const ts = (out.result as any)?.tradeSetup ?? null;
  const status: FullReplayReport['status'] = out.divergences.length > 0 || out.error ? 'DIVERGED' : diff.length === 0 ? 'MATCH' : 'DIFFERENT';
  return {
    snapshotId,
    status,
    diff,
    divergences: out.divergences.map((k) => k.slice(0, 300)),
    error: out.error,
    effects: { live: liveWrites.length, replay: replayWrites.length, ...effectsDiff(liveWrites, replayWrites) },
    replayed: {
      available: ts?.available ?? null,
      noTradeCode: ts?.noTradeCode ?? null,
      strategy: ts?.strategy ?? null,
      strike: ts?.strike ?? null,
      limitingFactor: ts?.noTradeDiagnostics?.limitingFactor?.summary ?? null,
    },
  };
}

/** A recorded write's target, in the same form replay effects use. */
function targetOf(e: { ch: string; op: string; key: string; target?: string }): string {
  if (e.target != null) return `${e.ch}:${e.target}`;
  if (e.ch === 'redis') {
    const m = /^redis\|[a-z]+\|\[("(?:[^"\\]|\\.)*")/.exec(e.key);
    return `redis:${m ? JSON.parse(m[1]) : e.op}`;
  }
  if (e.ch === 'sql') {
    const m = /"text":("(?:[^"\\]|\\.)*")/.exec(e.key);
    const text = m ? (JSON.parse(m[1]) as string).split('\u0001').join('?').replace(/\s+/g, ' ').trim().slice(0, 160) : e.op;
    return `sql:${text}`;
  }
  return `${e.ch}:${e.op}`;
}
