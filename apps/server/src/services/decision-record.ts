// ============================================================
// DECISION SNAPSHOT → DECISION RECORD → REPLAY (Phase 2, 2026-10-05)
// ============================================================
// One signal decision, made reproducible:
//
//   inputs (bars ≤ T, quotes, stored engine state)  ──► SignalDecisionSnapshot
//        frozen, versioned, per-input data quality      (signal_decision_snapshots)
//                         │
//                         ▼  deriveDecisionRecord — pure, no IO, no clock
//   S1 lifecycle advance + fill · trigger families (events, candidates,
//   parents, observation arbitration, watch) · common metrics · option
//   candidates (cost on the snapshot chain) · pre-build slot ranking
//                         │
//                         ▼
//                   DecisionRecord  (decision_records; canonical + sha256)
//
// The live poll runs the SAME pure cores (advanceStructureCore,
// evaluateFamiliesCore) on the same inputs (the snapshot's own round-tripped
// copy), so the record is what the engines decided. replay(snapshotId) loads
// the stored snapshot, then derives the record again with no network, broker,
// Redis, database or clock access, and refuses to run under a configuration
// other than the one recorded (CONFIG_MISMATCH) — it never substitutes
// current data or config.
//
// Not re-derived (their rows carry the snapshot id instead): the indicator
// engine, the safety gates, the option-leg build, the slot settlement and
// the setup-watch refresh — see NOT_REPLAYED.
// ============================================================

import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  BAR_MS_15M,
  TRIGGERS_BY_ID,
  buildLiquidityMap,
  buildSeriesContext,
  prepareMomentumSeries,
  type MomentumBar,
} from '@fno/analytics';
import {
  DECISION_RECORD_SCHEMA_VERSION,
  NONDETERMINISTIC_RECORD_FIELDS,
  SNAPSHOT_SCHEMA_VERSION,
  inputQuality,
  summarizeDataQuality,
  type DecisionCandidateRecord,
  type DecisionOptionCandidateRecord,
  type DecisionRecord,
  type Exchange,
  type FuturesChainResponse,
  type InputQuality,
  type OptionChain,
  type SignalDecisionSnapshot,
  type SnapshotBar,
  type SnapshotConfig,
  type SnapshotInputKey,
  type SnapshotVersions,
  type TradingMode,
} from '@fno/shared';
import {
  ANALYTICS_VERSION,
  ARBITRATION_VERSION,
  COST_VERSION,
  EVENT_ENGINE_VERSION,
  FNO_VALIDATION_PARAMS,
  OPTION_VERSION,
  PARENTING_VERSION,
  RISK_VERSION,
  STRATEGY_VERSION,
  STRUCTURE_PARAMS,
  TRIGGER_VERSION,
  liveLogicStamp,
} from '../config/trading-flags.js';
import {
  STRUCTURE_TF_BAR_MS,
  advanceStructureCore,
  fillCandidate,
  rejectionCloseCandidate,
  structureRulesFor,
  type LiveLifecycle,
  type StructureInputs,
} from './structure-live.js';
import { EMPTY_FAMILY_ROUTER_STATE, evaluateFamiliesCore, linkStructureToParent, type FamilyRouterState, type RoutedCandidate } from './trigger-router.js';
import { buildMetricsContext, parentAlreadyTraded, rankSlotCandidates, routedSlotCandidate, structureSlotCandidate, type SlotCandidate } from './slot-arbitration.js';

/** Parts of the live poll the record does not re-derive (their rows carry the snapshot id). */
export const NOT_REPLAYED = ['INDICATOR_ENGINE', 'SAFETY_GATES', 'OPTION_LEG_BUILD', 'SLOT_SETTLEMENT', 'SETUP_WATCH_REFRESH'] as const;

/** Tolerances (ms before T) an input may be as of and still be OK. */
export const INPUT_TOLERANCE_MS: Record<SnapshotInputKey, number> = {
  // Closed bars: the newest must be the bar that closed at T (no tolerance).
  ohlcv15m: 0,
  // 1h bars close on the hour: up to one bar before T.
  ohlcv1h: 60 * 60 * 1000,
  ohlcv5m: 0,
  // A quote / chain read just before T is as good as at T.
  futuresQuote: 2 * 60 * 1000,
  optionChain: 2 * 60 * 1000,
  optionMetrics: 2 * 60 * 1000,
  corporateActions: 24 * 60 * 60 * 1000,
};

// ---------------- canonical form ----------------

/**
 * Canonical JSON: object keys sorted, undefined dropped, non-finite numbers
 * as null (what JSON storage does to them), arrays in their own order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value instanceof Map) return canonicalJson(Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), v])));
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return 'null';
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The record without the declared nondeterministic fields — what equality and the hash are computed on. */
export function deterministicPart(record: DecisionRecord): Omit<DecisionRecord, (typeof NONDETERMINISTIC_RECORD_FIELDS)[number]> {
  const out: Record<string, unknown> = { ...record };
  for (const f of NONDETERMINISTIC_RECORD_FIELDS) delete out[f];
  return out as Omit<DecisionRecord, (typeof NONDETERMINISTIC_RECORD_FIELDS)[number]>;
}

export const canonicalRecord = (record: DecisionRecord): string => canonicalJson(deterministicPart(record));
export const recordHash = (record: DecisionRecord): string => sha256(canonicalRecord(record));

/** Paths at which two records differ, outside the declared nondeterministic fields. Empty = equal. */
export function recordDiff(a: DecisionRecord, b: DecisionRecord): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (out.length >= 50) return;
    const cx = canonicalJson(x);
    const cy = canonicalJson(y);
    if (cx === cy) return;
    const ox = JSON.parse(cx);
    const oy = JSON.parse(cy);
    if (ox && oy && typeof ox === 'object' && typeof oy === 'object' && Array.isArray(ox) === Array.isArray(oy)) {
      const keys = [...new Set([...Object.keys(ox), ...Object.keys(oy)])].sort();
      for (const k of keys) walk(ox[k], oy[k], path ? `${path}.${k}` : k);
      return;
    }
    out.push(path || '(root)');
  };
  walk(deterministicPart(a), deterministicPart(b), '');
  return out;
}

// ---------------- versions + config ----------------

function gitCommit(): string | null {
  return process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ?? process.env.GIT_COMMIT?.slice(0, 12) ?? null;
}

export function currentVersions(): SnapshotVersions {
  const stamp = liveLogicStamp();
  return {
    gitCommit: gitCommit(),
    analyticsVersion: ANALYTICS_VERSION,
    signalEngineVersion: stamp.logicVersion,
    logicFlagsHash: sha256(canonicalJson(stamp)),
    optionModelVersion: OPTION_VERSION,
    parentingVersion: PARENTING_VERSION,
    arbitrationVersion: ARBITRATION_VERSION,
    ruleVersion: `${TRIGGER_VERSION}+${EVENT_ENGINE_VERSION}`,
    strategyVersion: STRATEGY_VERSION,
    triggerVersions: Object.fromEntries([...TRIGGERS_BY_ID.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, t]) => [id, `${id}-${t.version ?? '1.0'}`])),
    riskVersion: RISK_VERSION,
    costModelVersion: COST_VERSION,
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
  };
}

export function decisionConfig(args: { triggerStages: Record<string, string>; structureOn: boolean; structureEntryTimeframe: '15m' | '5m'; structureEntryMode: 'TOUCH' | 'REJECTION_CLOSE' }): SnapshotConfig {
  const stages = Object.fromEntries(Object.entries(args.triggerStages).sort(([a], [b]) => a.localeCompare(b)));
  const params = { structure: { ...STRUCTURE_PARAMS }, fnoValidation: { ...FNO_VALIDATION_PARAMS } };
  const body = { triggerStages: stages, structureOn: args.structureOn, structureEntryTimeframe: args.structureEntryTimeframe, structureEntryMode: args.structureEntryMode, params, logicFlagsHash: sha256(canonicalJson(liveLogicStamp())) };
  return { triggerStages: stages, structureOn: args.structureOn, structureEntryTimeframe: args.structureEntryTimeframe, structureEntryMode: args.structureEntryMode, params, configHash: sha256(canonicalJson(body)) };
}

// ---------------- snapshot ----------------

/** A UUID-shaped id that is a hash of what identifies the poll (deterministic, no randomness). */
export function snapshotIdFor(exchange: Exchange, symbol: string, mode: TradingMode, decisionBarTime: number, polledAt: number): string {
  const h = sha256(`${exchange}|${symbol}|${mode}|${decisionBarTime}|${polledAt}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

const toBar = (b: MomentumBar): SnapshotBar => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 });

export interface SnapshotBuildArgs {
  symbol: string;
  exchange: Exchange;
  mode: TradingMode;
  decisionBarTime: number;
  polledAt: number;
  captureReason: SignalDecisionSnapshot['captureReason'];
  bars15m: readonly MomentumBar[];
  bars5m: readonly MomentumBar[] | null;
  closes1h: readonly number[];
  /** Open time of the newest 1h bar (null without bars). */
  last1hBarTime: number | null;
  chain: OptionChain | null;
  futures: FuturesChainResponse | null;
  optionMetrics: SignalDecisionSnapshot['inputs']['optionMetrics'];
  marketRegime: SignalDecisionSnapshot['inputs']['marketRegime'];
  structureState: StructureInputs | null;
  familyRouterState: FamilyRouterState | null;
  slotTradedKeys: readonly string[];
  config: SnapshotConfig;
  versions: SnapshotVersions;
  /** Where each input came from (provider / endpoint). */
  sources: { candles: string; chain: string; futures: string };
}

const INDEX_OR_COMMODITY = (exchange: Exchange, symbol: string) => exchange === 'MCX' || /NIFTY|SENSEX|BANKEX/.test(symbol);

/** Pure: the frozen input snapshot of one decision, with each input's data quality at T. */
export function buildSignalDecisionSnapshot(a: SnapshotBuildArgs): SignalDecisionSnapshot {
  const T = a.decisionBarTime;
  const last15 = a.bars15m.length ? a.bars15m[a.bars15m.length - 1] : null;
  const last5 = a.bars5m && a.bars5m.length ? a.bars5m[a.bars5m.length - 1] : null;
  const futuresAsOf = a.futures?.timestamp ?? null;
  const q = (key: SnapshotInputKey, asOf: number | null, source: string): InputQuality => inputQuality({ asOf, decisionBarTime: T, source, toleranceMs: INPUT_TOLERANCE_MS[key] });
  const corporateApplicable = !INDEX_OR_COMMODITY(a.exchange, a.symbol);
  const inputs: Record<SnapshotInputKey, InputQuality> = {
    // A closed bar is as of its close.
    ohlcv15m: q('ohlcv15m', last15 ? last15.time + BAR_MS_15M : null, a.sources.candles),
    ohlcv1h: q('ohlcv1h', a.last1hBarTime != null ? a.last1hBarTime + 60 * 60 * 1000 : null, a.sources.candles),
    ohlcv5m: q('ohlcv5m', last5 ? last5.time + STRUCTURE_TF_BAR_MS['5m'] : null, a.sources.candles),
    futuresQuote: q('futuresQuote', futuresAsOf, a.sources.futures),
    optionChain: q('optionChain', a.chain?.timestamp ?? null, a.sources.chain),
    optionMetrics: q('optionMetrics', a.chain?.timestamp ?? null, `derived:${a.sources.chain}`),
    // Not fetched in the decision path (indices / commodities have none).
    corporateActions: q('corporateActions', null, corporateApplicable ? 'not fetched in the decision path' : 'not applicable (index / commodity)'),
  };
  const notApplicable: SnapshotInputKey[] = [];
  if (a.bars5m == null) notApplicable.push('ohlcv5m');
  if (!corporateApplicable) notApplicable.push('corporateActions');
  const dataQuality = summarizeDataQuality(inputs, notApplicable);

  // The liquidity map of today's session on the closed 15m bars ≤ T (diagnostic context).
  let liquidityMap: unknown[] = [];
  if (a.bars15m.length >= 2) {
    const series = prepareMomentumSeries(a.bars15m.map(toBar));
    const s = series.sessionStarts.length - 1;
    const ctx = buildSeriesContext(series);
    const atr = ctx.atrAt(series.bars.length - 1);
    if (s >= 0 && atr != null && atr > 0) liquidityMap = buildLiquidityMap(a.symbol, series, s, series.bars.length, atr);
  }

  const snapshot: SignalDecisionSnapshot = {
    snapshotId: snapshotIdFor(a.exchange, a.symbol, a.mode, T, a.polledAt),
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    symbol: a.symbol,
    exchange: a.exchange,
    mode: a.mode,
    decisionBarTime: T,
    polledAt: a.polledAt,
    captureReason: a.captureReason,
    versions: a.versions,
    config: a.config,
    dataQuality,
    inputs: {
      ohlcv15m: a.bars15m.map(toBar),
      ohlcv5m: a.bars5m ? a.bars5m.map(toBar) : null,
      ohlcv1hCloses: [...a.closes1h],
      spot: a.chain?.spotPrice ?? null,
      futures: a.futures,
      optionChain: a.chain,
      optionMetrics: a.optionMetrics,
      marketRegime: a.marketRegime,
      liquidityMap,
      corporateActions: { applicable: corporateApplicable, actions: [] },
      structureState: a.structureState,
      familyRouterState: a.familyRouterState,
      slotTradedKeys: [...a.slotTradedKeys].sort(),
    },
  };
  // Stored and reloaded exactly as JSON: the live record is derived from this same round-tripped form.
  return deepFreeze(thawSnapshotRow(JSON.parse(JSON.stringify(freezeSnapshotRow(snapshot)))));
}

export interface SnapshotRow {
  snapshot_id: string;
  symbol: string;
  exchange: string;
  mode: string;
  decision_bar_time: string;
  polled_at: string;
  capture_reason: string;
  snapshot_schema_version: string;
  versions: unknown;
  config?: unknown;
  data_quality: unknown;
  inputs: Record<string, unknown>;
}

/** The stored form: the option chain gzip + base64 inside inputs; the config inside versions.config. */
export function freezeSnapshotRow(s: SignalDecisionSnapshot): SnapshotRow {
  const { optionChain, ...rest } = s.inputs;
  return {
    snapshot_id: s.snapshotId,
    symbol: s.symbol,
    exchange: s.exchange,
    mode: s.mode,
    decision_bar_time: new Date(s.decisionBarTime).toISOString(),
    polled_at: new Date(s.polledAt).toISOString(),
    capture_reason: s.captureReason,
    snapshot_schema_version: s.schemaVersion,
    versions: { ...s.versions, config: s.config },
    data_quality: s.dataQuality,
    inputs: { ...rest, optionChainGz: optionChain ? gzipSync(Buffer.from(JSON.stringify(optionChain))).toString('base64') : null },
  };
}

export function thawSnapshotRow(r: SnapshotRow): SignalDecisionSnapshot {
  const { optionChainGz, ...rest } = r.inputs as Record<string, unknown> & { optionChainGz?: string | null };
  const { config, ...versions } = r.versions as SnapshotVersions & { config: SnapshotConfig };
  return {
    snapshotId: r.snapshot_id,
    schemaVersion: r.snapshot_schema_version,
    symbol: r.symbol,
    exchange: r.exchange as Exchange,
    mode: r.mode as TradingMode,
    decisionBarTime: new Date(r.decision_bar_time).getTime(),
    polledAt: new Date(r.polled_at).getTime(),
    captureReason: r.capture_reason as SignalDecisionSnapshot['captureReason'],
    versions,
    config,
    dataQuality: r.data_quality as SignalDecisionSnapshot['dataQuality'],
    inputs: { ...(rest as any), optionChain: optionChainGz ? (JSON.parse(gunzipSync(Buffer.from(optionChainGz, 'base64')).toString('utf8')) as OptionChain) : null },
  };
}

// ---------------- the deterministic core ----------------

const istDate = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const asBars = (bars: readonly SnapshotBar[]): MomentumBar[] => bars.map((b) => ({ ...b }));

/**
 * Pure: the DecisionRecord of a snapshot. Reads only the snapshot and the
 * code; `generatedAt` is the one declared nondeterministic field (passed in,
 * never read from a clock here).
 */
export function deriveDecisionRecord(snap: SignalDecisionSnapshot, generatedAt: number): DecisionRecord {
  const { symbol, exchange, mode, polledAt, config } = snap;
  const bars15 = asBars(snap.inputs.ohlcv15m);
  const bars5 = snap.inputs.ohlcv5m ? asBars(snap.inputs.ohlcv5m) : null;
  const chain = (snap.inputs.optionChain as OptionChain | null) ?? null;
  const spot = snap.inputs.spot;
  const dq = snap.dataQuality.inputs;
  const barsDegraded = dq.ohlcv15m.status !== 'OK' || (bars5 != null && dq.ohlcv5m.status !== 'OK');
  const chainDegraded = dq.optionChain.status !== 'OK';

  // --- S1: the structure lifecycle and its fill ---
  // Stored state is cloned: the snapshot is frozen and the cores build new state from it.
  const structureIn = snap.inputs.structureState ? (structuredClone(snap.inputs.structureState) as StructureInputs) : null;
  let structure: DecisionRecord['structure'] = { status: 'OFF', reset: null, transitions: [], lifecycles: [], fill: null };
  let fillLc: LiveLifecycle | null = null;
  let fillPrice: number | null = null;
  if (config.structureOn && structureIn) {
    const adv = advanceStructureCore({ prev: structureIn.prev, bars15: bars15, bars5, outcomes: structureIn.outcomes, exchange, underlying: symbol, mode, now: polledAt, spot, entryMode: config.structureEntryMode });
    if (!adv) structure = { ...structure, status: 'NOT_ENOUGH_BARS' };
    else {
      const tf = adv.state.timeframe ?? '15m';
      const lastBar = (bars5 ?? bars15)[(bars5 ?? bars15).length - 1] ?? null;
      let fill: DecisionRecord['structure']['fill'] = null;
      if (config.structureEntryMode === 'REJECTION_CLOSE') {
        const out = lastBar ? rejectionCloseCandidate(adv.state, { time: lastBar.time, open: lastBar.open, high: lastBar.high, low: lastBar.low, close: lastBar.close }, structureRulesFor(tf).fillWithinBars, STRUCTURE_TF_BAR_MS[tf]) : null;
        if (out) {
          fill = { lifecycleId: out.lc.id, kind: out.kind, price: out.kind === 'FILL' ? out.entry : null };
          if (out.kind === 'FILL') {
            fillLc = out.lc;
            fillPrice = out.entry;
          }
        }
      } else if (spot != null) {
        const lc = fillCandidate(adv.state, spot, lastBar?.time ?? null);
        if (lc) {
          fill = { lifecycleId: lc.id, kind: 'FILL', price: spot };
          fillLc = lc;
          fillPrice = spot;
        }
      }
      structure = {
        status: 'ADVANCED',
        reset: adv.reset,
        transitions: adv.events,
        lifecycles: adv.state.lifecycles.map((l) => ({ id: l.id, stage: l.stage, direction: l.direction, entry: l.entry, stop: l.stop, t1: l.t1?.price ?? null, outcome: l.live ? `${l.live.outcome}${l.live.code ? `:${l.live.code}` : ''}` : null })),
        fill,
      };
    }
  }

  // --- the trigger families ---
  const familyState = snap.inputs.familyRouterState ? (structuredClone(snap.inputs.familyRouterState) as FamilyRouterState) : null;
  const fam = config.structureOn && familyState
    ? evaluateFamiliesCore({ underlying: symbol, exchange, mode, bars: bars15, chain, now: polledAt, stages: config.triggerStages as any, state: familyState ?? EMPTY_FAMILY_ROUTER_STATE })
    : null;
  const todo = new Set(fam?.todo ?? []);
  const evaluated: RoutedCandidate[] = (fam?.routed ?? []).filter((rc) => todo.has(rc.candidate.decisionIndex));
  const handed = new Set((fam?.paper ?? []).map((rc) => rc.lifecycleId));
  const end = fam?.end ?? -1;

  const candidates: DecisionCandidateRecord[] = evaluated.map((rc) => {
    const c = rc.candidate;
    return {
      candidateId: rc.lifecycleId,
      source: c.triggerId,
      direction: c.direction,
      decisionTime: c.decisionTime,
      stage: rc.stage,
      bucket: c.bucket,
      entry: c.entry,
      stop: c.stop,
      t1: c.t1?.price ?? null,
      rToT1: c.rToT1,
      parentId: rc.parentId ?? null,
      anchorKeys: rc.anchorKeys ?? [],
      eventIds: [...c.eventIds],
      eligible: rc.risk.wouldTrade,
      reason: rc.risk.reason,
      handedToSlot: handed.has(rc.lifecycleId),
      degraded: barsDegraded || (c.decisionIndex === end && chainDegraded),
      observation: rc.arbitration ? { role: rc.arbitration.role, rank: rc.arbitration.rank ?? null, reason: rc.arbitration.reason ?? null, selectedTriggerId: rc.arbitration.selectedTriggerId ?? null } : null,
    };
  });

  // --- slot: common metrics and the pre-build ranking ---
  const lastBar15 = bars15[bars15.length - 1] ?? null;
  const decisionBarClose = lastBar15 ? lastBar15.time + BAR_MS_15M : snap.decisionBarTime;
  const metricsCtx = buildMetricsContext(bars15, istDate(polledAt), snap.inputs.optionMetrics.positioningNet ?? null);
  const traded = new Set(snap.inputs.slotTradedKeys);
  const pool: SlotCandidate[] = [];
  const parentTraded: string[] = [];
  if (fillLc) {
    const link = { ...linkStructureToParent(fillLc, fam?.linkage ?? null), decisionTime: decisionBarClose };
    candidates.unshift({
      candidateId: fillLc.id,
      source: fillLc.triggerId ?? 'S1',
      direction: fillLc.direction,
      decisionTime: lastBar15?.time ?? snap.decisionBarTime,
      stage: 'LIVE',
      bucket: null,
      entry: fillPrice,
      stop: fillLc.stop,
      t1: fillLc.t1?.price ?? null,
      rToT1: fillLc.rToT1,
      parentId: link.parentId,
      anchorKeys: link.anchorKeys,
      eventIds: [],
      eligible: true,
      reason: null,
      handedToSlot: !parentAlreadyTraded(link.anchorKeys, traded),
      degraded: barsDegraded || chainDegraded,
      observation: null,
    });
    if (parentAlreadyTraded(link.anchorKeys, traded)) parentTraded.push(fillLc.id);
    else pool.push(structureSlotCandidate(fillLc, fillPrice ?? spot ?? fillLc.entry ?? 0, null, link, metricsCtx));
  }
  for (const rc of fam?.paper ?? []) {
    const slot = routedSlotCandidate(rc, metricsCtx);
    if (parentAlreadyTraded(slot.anchorKeys, traded)) parentTraded.push(rc.lifecycleId);
    else pool.push(slot);
  }
  const ranking = pool.length > 0 ? rankSlotCandidates(pool) : null;
  const arbitration: DecisionRecord['arbitration'] =
    pool.length > 0 || parentTraded.length > 0
      ? {
          parentAlreadyTraded: parentTraded,
          order: ranking ? ranking.order.map((i) => pool[i].candidateId) : [],
          used: ranking ? [...ranking.used] : [],
          skipped: ranking ? [...ranking.skipped] : [],
          lostOn: ranking ? Object.fromEntries([...ranking.lostOn.entries()].sort(([x], [y]) => x - y).map(([i, crit]) => [pool[i].candidateId, crit])) : {},
        }
      : null;

  // --- option candidates (cost of each newest-bar family candidate's leg on the snapshot chain) ---
  const optionCandidates: DecisionOptionCandidateRecord[] = evaluated
    .filter((rc) => rc.candidate.decisionIndex === end && rc.cost)
    .map((rc) => ({
      candidateId: rc.lifecycleId,
      side: rc.cost!.option?.side ?? null,
      strike: rc.cost!.option?.strike ?? null,
      expiry: rc.cost!.option?.expiry ?? null,
      premium: rc.cost!.option?.premium ?? null,
      costPctOfPremium: rc.cost!.costPctOfPremium,
      netR: rc.cost!.netR,
      quality: rc.cost!.quality,
      degraded: chainDegraded,
    }));

  const finalStatus: DecisionRecord['finalStatus'] = candidates.length === 0 ? 'NO_CANDIDATE' : pool.length === 0 ? 'NO_ELIGIBLE_CANDIDATE' : 'CANDIDATES_TO_SLOT';
  return {
    schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    snapshotId: snap.snapshotId,
    symbol,
    exchange,
    mode,
    decisionBarTime: snap.decisionBarTime,
    decidedAt: polledAt,
    generatedAt,
    degraded: snap.dataQuality.degraded,
    degradedReasons: [...snap.dataQuality.reasons],
    structure,
    families: {
      status: fam?.status ?? 'NOT_RUN',
      session: fam?.session ?? null,
      evaluatedBarTimes: (fam?.todo ?? []).map((i) => bars15[i].time),
      events: fam?.status === 'EVALUATED' ? fam.events : [],
      linkage: fam?.linkage ?? null,
      watch: (fam?.watch ?? []).map((w) => ({ lifecycleId: w.lifecycleId, lastIndex: w.lastIndex, ended: w.ended })),
      triggerFailures: (fam?.triggerFailures ?? []).map((f) => ({ ...f })),
    },
    candidates,
    triggerEventIds: candidates.filter((c) => c.eventIds.length > 0).map((c) => ({ candidateId: c.candidateId, eventIds: c.eventIds })),
    metrics: pool.map((p) => ({ ...p, anchorKeys: [...p.anchorKeys] })),
    optionCandidates,
    arbitration,
    finalStatus,
    selectedCandidateId: ranking ? pool[ranking.winner].candidateId : null,
    notReplayed: [...NOT_REPLAYED],
  };
}

// ---------------- replay ----------------

export type ReplayResult =
  | { status: 'OK'; record: DecisionRecord; hash: string }
  | { status: 'CONFIG_MISMATCH'; recordedConfigHash: string; currentConfigHash: string }
  | { status: 'NOT_FOUND' };

/**
 * Pure replay of a loaded snapshot: refuses (CONFIG_MISMATCH) when the
 * running configuration is not the one the snapshot recorded — it never
 * re-derives under substituted config. `currentConfigHash` is the running
 * process's decisionConfig(...).configHash for the snapshot's own settings.
 */
export function replaySnapshot(snap: SignalDecisionSnapshot, currentConfigHash: string, generatedAt = 0): ReplayResult {
  if (snap.config.configHash !== currentConfigHash) return { status: 'CONFIG_MISMATCH', recordedConfigHash: snap.config.configHash, currentConfigHash };
  const record = deriveDecisionRecord(snap, generatedAt);
  return { status: 'OK', record, hash: recordHash(record) };
}

/** The running configuration's hash for a snapshot's own (recorded) settings. */
export function currentConfigHashFor(snap: SignalDecisionSnapshot): string {
  return decisionConfig({ triggerStages: snap.config.triggerStages, structureOn: snap.config.structureOn, structureEntryTimeframe: snap.config.structureEntryTimeframe, structureEntryMode: snap.config.structureEntryMode }).configHash;
}
