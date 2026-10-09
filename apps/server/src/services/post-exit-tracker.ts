// ============================================================
// POST-EXIT EXCURSION — what happened after the paper exit (2026-10-09)
// ============================================================
// A paper trade that exits at its target (or its stop) stops being tracked, so
// nothing recorded how far the contract and its underlying went AFTER that
// instant — which is the evidence needed to judge whether the target is
// realistic (a target touched once and reversed vs a move that kept going) and
// whether a limit fill at the target is believable.
//
// From the close of a trade until its session ends, the option's last price
// and the underlying's spot are folded into a running record from the same
// feeds the price monitor already reads: the option-chain quote at each sweep
// (every ~90 s) and, where the token is subscribed, live ticks. The record is
// written once, when the watch ends, to trade_post_exit.
//
// What this is NOT:
//   * It never changes a trade. The outcome, exit price, target, stop and
//     strategy version were fixed at the close; this only adds a row beside.
//   * It is a LOWER BOUND. The peak is the best price the sweeps and ticks
//     happened to see; a spike between observations is invisible. Every record
//     carries its observation count and its largest gap so that is auditable.
//   * It does not infer. With no usable observation the row says NO_DATA, and a
//     trade with no session left after its exit says NOT_WATCHED — neither
//     contributes a number.
// ============================================================

import { FO_SEGMENT } from '@fno/shared';
import type { Exchange, Tick } from '@fno/shared';
import { redis, scanKeys } from '../lib/redis.js';
import { sql } from '../lib/db.js';
import { insertOnce } from '../lib/insert-once.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { TRADE_MEASUREMENT_MIGRATION } from './trade-costs.js';
import { minutesToSessionClose } from './validation-gates.js';
import { buildOptionChain } from './option-chain.js';
import type { MarketDataProvider } from '../providers/interface.js';
import type { SubscriptionManager, SubscriptionTarget } from '../lib/subscription-manager.js';

export const POST_EXIT_VERSION = 'POSTEXIT-1.0';
export const POST_EXIT_KEY_PREFIX = 'post_exit_watch:';
const TICK_CLIENT_ID = 'post-exit-tracker';
/** A watch never outlives this, whatever the session length. */
export const POST_EXIT_MAX_WATCH_MS = 8 * 60 * 60_000;
/** A price this far from the last accepted one is a feed error, not a move (the monitor's own tick sanity band). */
export const POST_EXIT_SANITY_MIN_RATIO = 0.5;
export const POST_EXIT_SANITY_MAX_RATIO = 2;
const REDIS_TTL_SECONDS = 36 * 60 * 60;

export type PostExitStatus = 'OBSERVED' | 'NO_DATA' | 'NOT_WATCHED';

export interface PostExitWatch {
  signalId: string;
  symbol: string;
  exchange: string;
  mode: string;
  side: 'CE' | 'PE';
  strike: number;
  expiry: string | null;
  token: string | null;
  bullish: boolean;
  outcome: string;
  closeReason: string | null;
  entry: number;
  initialStop: number | null;
  target: number | null;
  exitPrice: number | null;
  exitAt: number;
  endAt: number;
  underlyingEntry: number | null;
  atrAtEntry: number | null;
  obs: { total: number; tick: number; sweep: number; rejected: number; firstAt: number | null; lastAt: number | null; maxGapMs: number };
  option: { max: number | null; maxAt: number | null; min: number | null; minAt: number | null; last: number | null; lastAt: number | null };
  underlying: {
    first: number | null;
    last: number | null;
    /** Best / worst move versus the underlying at the MINT, signed so positive is favourable. */
    maxFavVsEntry: number | null;
    maxFavVsEntryAt: number | null;
    maxAdvVsEntry: number | null;
    /** Best / worst move versus the first post-exit observation. */
    maxFavVsFirst: number | null;
    maxAdvVsFirst: number | null;
  };
}

/** What the close path knows about the trade being closed. */
export interface PostExitSource {
  signalId?: string | null;
  side?: string | null;
  strike?: number | null;
  expiry?: string | null;
  structureType?: string | null;
  entry?: number | null;
  initialStopLoss?: number | null;
  stopLoss?: number | null;
  target?: number | null;
  direction?: string | null;
  excursion?: { underlyingEntry: number | null; atrAtEntry: number | null } | null;
}

const r4 = (n: number | null) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10_000) / 10_000);

/** Pure: the watch for a closed trade, or the reason none can be made. */
export function buildPostExitWatch(
  s: PostExitSource,
  close: { symbol: string; exchange: string; mode: string; outcome: string; reason: string | null; exitPrice: number | null; exitAt: number }
): { watch: PostExitWatch } | { skip: 'NOT_WATCHED' | 'NOT_APPLICABLE'; why: string } {
  if (!s.signalId) return { skip: 'NOT_APPLICABLE', why: 'no signal row' };
  if (s.structureType === 'SPREAD' || (s.side !== 'CE' && s.side !== 'PE') || s.strike == null || !(Number(s.entry) > 0)) {
    return { skip: 'NOT_APPLICABLE', why: 'not a single-leg option trade' };
  }
  const left = minutesToSessionClose(close.exchange as Exchange, close.exitAt);
  if (left == null || !(left > 0)) return { skip: 'NOT_WATCHED', why: 'no session time left after the exit' };
  return {
    watch: {
      signalId: s.signalId,
      symbol: close.symbol,
      exchange: close.exchange,
      mode: close.mode,
      side: s.side,
      strike: s.strike,
      expiry: s.expiry ?? null,
      token: null,
      bullish: s.side !== 'PE',
      outcome: close.outcome,
      closeReason: close.reason,
      entry: Number(s.entry),
      initialStop: s.initialStopLoss ?? s.stopLoss ?? null,
      target: s.target ?? null,
      exitPrice: close.exitPrice,
      exitAt: close.exitAt,
      endAt: close.exitAt + Math.min(left * 60_000, POST_EXIT_MAX_WATCH_MS),
      underlyingEntry: s.excursion?.underlyingEntry ?? null,
      atrAtEntry: s.excursion?.atrAtEntry ?? null,
      obs: { total: 0, tick: 0, sweep: 0, rejected: 0, firstAt: null, lastAt: null, maxGapMs: 0 },
      option: { max: null, maxAt: null, min: null, minAt: null, last: null, lastAt: null },
      underlying: { first: null, last: null, maxFavVsEntry: null, maxFavVsEntryAt: null, maxAdvVsEntry: null, maxFavVsFirst: null, maxAdvVsFirst: null },
    },
  };
}

/**
 * Pure: folds one observation into the watch (a new object). An observation
 * outside (exitAt, endAt], or a price outside the sanity band around the last
 * accepted one, is not used (a rejected price is counted, never guessed at).
 */
export function foldPostExitObservation(
  w: PostExitWatch,
  o: { at: number; premium: number | null; underlying: number | null; via: 'TICK' | 'SWEEP' }
): PostExitWatch {
  if (!(o.at > w.exitAt) || o.at > w.endAt) return w;
  const ref = w.option.last ?? w.exitPrice;
  let premium = o.premium != null && o.premium > 0 ? o.premium : null;
  let rejected = 0;
  if (premium != null && ref != null && ref > 0 && (premium < ref * POST_EXIT_SANITY_MIN_RATIO || premium > ref * POST_EXIT_SANITY_MAX_RATIO)) {
    premium = null;
    rejected = 1;
  }
  const underlying = o.underlying != null && o.underlying > 0 ? o.underlying : null;
  if (premium == null && underlying == null) return rejected ? { ...w, obs: { ...w.obs, rejected: w.obs.rejected + 1 } } : w;

  const prevAt = w.obs.lastAt ?? w.exitAt;
  const obs = {
    total: w.obs.total + 1,
    tick: w.obs.tick + (o.via === 'TICK' ? 1 : 0),
    sweep: w.obs.sweep + (o.via === 'SWEEP' ? 1 : 0),
    rejected: w.obs.rejected + rejected,
    firstAt: w.obs.firstAt ?? o.at,
    lastAt: Math.max(prevAt, o.at),
    maxGapMs: Math.max(w.obs.maxGapMs, o.at - prevAt),
  };

  let option = w.option;
  if (premium != null) {
    option = {
      max: option.max == null || premium > option.max ? premium : option.max,
      maxAt: option.max == null || premium > option.max ? o.at : option.maxAt,
      min: option.min == null || premium < option.min ? premium : option.min,
      minAt: option.min == null || premium < option.min ? o.at : option.minAt,
      last: premium,
      lastAt: o.at,
    };
  }

  let u = w.underlying;
  if (underlying != null) {
    const sign = w.bullish ? 1 : -1;
    const first = u.first ?? underlying;
    const vsEntry = w.underlyingEntry != null && w.underlyingEntry > 0 ? sign * (underlying - w.underlyingEntry) : null;
    const vsFirst = sign * (underlying - first);
    u = {
      first,
      last: underlying,
      maxFavVsEntry: vsEntry == null ? u.maxFavVsEntry : u.maxFavVsEntry == null || vsEntry > u.maxFavVsEntry ? vsEntry : u.maxFavVsEntry,
      maxFavVsEntryAt: vsEntry != null && (u.maxFavVsEntry == null || vsEntry > u.maxFavVsEntry) ? o.at : u.maxFavVsEntryAt,
      maxAdvVsEntry: vsEntry == null ? u.maxAdvVsEntry : u.maxAdvVsEntry == null || -vsEntry > u.maxAdvVsEntry ? -vsEntry : u.maxAdvVsEntry,
      maxFavVsFirst: u.maxFavVsFirst == null || vsFirst > u.maxFavVsFirst ? vsFirst : u.maxFavVsFirst,
      maxAdvVsFirst: u.maxAdvVsFirst == null || -vsFirst > u.maxAdvVsFirst ? -vsFirst : u.maxAdvVsFirst,
    };
  }
  return { ...w, obs, option, underlying: u };
}

export interface PostExitRecord {
  version: string;
  status: PostExitStatus;
  /** OBSERVED_SAMPLED: the peak is a lower bound — it is the best price the observations happened to see. */
  basis: 'OBSERVED_SAMPLED' | 'NONE';
  note: string;
  outcome: string;
  closeReason: string | null;
  entry: number;
  target: number | null;
  initialStop: number | null;
  exitPrice: number | null;
  exitAt: number;
  watchedUntil: number | null;
  observations: { total: number; tick: number; sweep: number; rejectedPrices: number; firstAt: number | null; lastAt: number | null; maxGapSeconds: number | null; coveragePct: number | null };
  option: {
    maxAfter: number | null;
    maxAfterAt: number | null;
    minAfter: number | null;
    minAfterAt: number | null;
    last: number | null;
    /** Best price seen after the exit, minus the exit price, in ₹ / % of the exit price / R of the planned risk. */
    maxBeyondExit: number | null;
    maxBeyondExitPct: number | null;
    maxBeyondExitR: number | null;
    /** Worst price after the exit versus the exit price, same units (negative = gave back). */
    minVsExit: number | null;
    minVsExitPct: number | null;
    /** Best post-exit price minus the TARGET, in R (positive = the price went through the target). */
    peakThroughTargetR: number | null;
    returnedToEntry: boolean | null;
    minutesToPeak: number | null;
  };
  underlying: {
    entry: number | null;
    atr: number | null;
    maxFavVsEntry: number | null;
    maxFavVsEntryAtr: number | null;
    maxAdvVsEntry: number | null;
    maxAdvVsEntryAtr: number | null;
    maxFavVsFirst: number | null;
    maxAdvVsFirst: number | null;
  };
}

/** Pure: the record a watch becomes when it ends (or is skipped, with the reason as the note). */
export function finalizePostExit(w: PostExitWatch, skip?: { status: 'NOT_WATCHED'; why: string }): PostExitRecord {
  const risk = w.initialStop != null && w.entry > w.initialStop ? w.entry - w.initialStop : null;
  const exit = w.exitPrice;
  const status: PostExitStatus = skip ? skip.status : w.obs.total > 0 ? 'OBSERVED' : 'NO_DATA';
  const span = w.endAt - w.exitAt;
  const lastObs = w.obs.lastAt;
  const gapToEnd = lastObs != null ? Math.max(0, w.endAt - lastObs) : null;
  const maxGap = w.obs.total > 0 ? Math.max(w.obs.maxGapMs, gapToEnd ?? 0) : null;
  const beyond = w.option.max != null && exit != null ? w.option.max - exit : null;
  const minVs = w.option.min != null && exit != null ? w.option.min - exit : null;
  const atr = w.atrAtEntry != null && w.atrAtEntry > 0 ? w.atrAtEntry : null;
  const inAtr = (v: number | null) => (v == null || atr == null ? null : r4(v / atr));
  return {
    version: POST_EXIT_VERSION,
    status,
    basis: w.obs.total > 0 ? 'OBSERVED_SAMPLED' : 'NONE',
    note:
      skip?.why ??
      (w.obs.total > 0
        ? 'Sampled from option-chain quotes and live ticks after the paper exit: the peak is a lower bound (a spike between observations is invisible). The trade outcome is unchanged.'
        : 'No usable price was observed after the exit — nothing is inferred.'),
    outcome: w.outcome,
    closeReason: w.closeReason,
    entry: w.entry,
    target: w.target,
    initialStop: w.initialStop,
    exitPrice: exit,
    exitAt: w.exitAt,
    watchedUntil: skip ? null : w.endAt,
    observations: {
      total: w.obs.total,
      tick: w.obs.tick,
      sweep: w.obs.sweep,
      rejectedPrices: w.obs.rejected,
      firstAt: w.obs.firstAt,
      lastAt: w.obs.lastAt,
      maxGapSeconds: maxGap == null ? null : Math.round(maxGap / 1000),
      coveragePct: span > 0 && lastObs != null ? Math.round(Math.min(1, (lastObs - w.exitAt) / span) * 1000) / 10 : null,
    },
    option: {
      maxAfter: r4(w.option.max),
      maxAfterAt: w.option.maxAt,
      minAfter: r4(w.option.min),
      minAfterAt: w.option.minAt,
      last: r4(w.option.last),
      maxBeyondExit: r4(beyond),
      maxBeyondExitPct: beyond != null && exit != null && exit > 0 ? r4((beyond / exit) * 100) : null,
      maxBeyondExitR: beyond != null && risk != null ? r4(beyond / risk) : null,
      minVsExit: r4(minVs),
      minVsExitPct: minVs != null && exit != null && exit > 0 ? r4((minVs / exit) * 100) : null,
      peakThroughTargetR: w.option.max != null && w.target != null && risk != null ? r4((w.option.max - w.target) / risk) : null,
      returnedToEntry: w.option.min == null ? null : w.option.min <= w.entry,
      minutesToPeak: w.option.maxAt != null ? Math.round((w.option.maxAt - w.exitAt) / 60_000) : null,
    },
    underlying: {
      entry: w.underlyingEntry,
      atr,
      maxFavVsEntry: r4(w.underlying.maxFavVsEntry),
      maxFavVsEntryAtr: inAtr(w.underlying.maxFavVsEntry),
      maxAdvVsEntry: r4(w.underlying.maxAdvVsEntry),
      maxAdvVsEntryAtr: inAtr(w.underlying.maxAdvVsEntry),
      maxFavVsFirst: r4(w.underlying.maxFavVsFirst),
      maxAdvVsFirst: r4(w.underlying.maxAdvVsFirst),
    },
  };
}

// ---------------- persistence ----------------

async function persistRecord(w: PostExitWatch, record: PostExitRecord): Promise<void> {
  await insertOnce(sql`
    INSERT INTO trade_post_exit (signal_id, symbol, exchange, outcome, close_reason, exit_at, watched_until, post_exit_version, status, record)
    VALUES (${w.signalId}, ${w.symbol}, ${w.exchange}, ${w.outcome}, ${w.closeReason}, ${new Date(w.exitAt)},
      ${record.watchedUntil != null ? new Date(record.watchedUntil) : null}, ${record.version}, ${record.status}, ${sql.json(record as any)})
  `);
}

const keyOf = (signalId: string) => `${POST_EXIT_KEY_PREFIX}${signalId}`;

/**
 * Called by the close path once a trade's outcome is recorded. Registers the
 * watch (first caller wins) or writes the explicit NOT_WATCHED row. Never
 * throws and never waits on anything the close depends on.
 */
export function registerPostExitWatch(
  s: PostExitSource,
  close: { symbol: string; exchange: string; mode: string; outcome: string; reason: string | null; exitPrice: number | null; exitAt: number }
): void {
  void (async () => {
    try {
      if (!schemaFileReady(TRADE_MEASUREMENT_MIGRATION)) return;
      const built = buildPostExitWatch(s, close);
      if ('skip' in built) {
        if (built.skip === 'NOT_WATCHED' && s.signalId) {
          const stub: PostExitWatch = {
            signalId: s.signalId, symbol: close.symbol, exchange: close.exchange, mode: close.mode, side: (s.side as 'CE' | 'PE') ?? 'CE', strike: s.strike ?? 0, expiry: s.expiry ?? null,
            token: null, bullish: s.side !== 'PE', outcome: close.outcome, closeReason: close.reason, entry: Number(s.entry ?? 0), initialStop: s.initialStopLoss ?? s.stopLoss ?? null,
            target: s.target ?? null, exitPrice: close.exitPrice, exitAt: close.exitAt, endAt: close.exitAt, underlyingEntry: s.excursion?.underlyingEntry ?? null, atrAtEntry: s.excursion?.atrAtEntry ?? null,
            obs: { total: 0, tick: 0, sweep: 0, rejected: 0, firstAt: null, lastAt: null, maxGapMs: 0 },
            option: { max: null, maxAt: null, min: null, minAt: null, last: null, lastAt: null },
            underlying: { first: null, last: null, maxFavVsEntry: null, maxFavVsEntryAt: null, maxAdvVsEntry: null, maxFavVsFirst: null, maxAdvVsFirst: null },
          };
          await persistRecord(stub, finalizePostExit(stub, { status: 'NOT_WATCHED', why: built.why }));
        }
        return;
      }
      const ttl = Math.min(REDIS_TTL_SECONDS, Math.ceil((built.watch.endAt - Date.now()) / 1000) + 3600);
      await redis.set(keyOf(built.watch.signalId), JSON.stringify(built.watch), 'EX', Math.max(ttl, 3600), 'NX');
    } catch (err: any) {
      logger.warn({ error: err.message, signalId: s.signalId }, 'Post-exit tracker: could not register a watch');
    }
  })();
}

// ---------------- the sampler (price-monitor sweep + ticks) ----------------

/** Watches in memory: ticks fold here between sweeps, the sweep persists them. */
const active = new Map<string, PostExitWatch>();
const byToken = new Map<string, string>();
const subscribedTokens = new Map<string, SubscriptionTarget>();
let sampling = false;

function legOf(chain: { strikes: Array<{ strike: number; call?: any; put?: any }> }, strike: number, side: 'CE' | 'PE') {
  const row = chain.strikes.find((x) => x.strike === strike);
  return side === 'CE' ? row?.call : row?.put;
}

/** A live tick for a watched contract. Only a DATA_FRESH token counts (the monitor's own rule). */
export function onPostExitTick(tick: Pick<Tick, 'token' | 'ltp'>, feedState: string | null): void {
  const id = byToken.get(tick.token);
  if (!id) return;
  if (feedState != null && feedState !== 'DATA_FRESH') return;
  const w = active.get(id);
  if (!w || !(tick.ltp > 0)) return;
  active.set(id, foldPostExitObservation(w, { at: Date.now(), premium: tick.ltp, underlying: null, via: 'TICK' }));
}

/**
 * One sampling pass: fold the option quote and the spot of every open watch,
 * finalise the ones whose session has ended, keep the tick subscriptions in
 * step. Re-entrant calls are dropped. Never throws.
 */
export async function samplePostExitWatches(provider: MarketDataProvider, subscriptions?: SubscriptionManager, now = Date.now()): Promise<{ watching: number; finalized: number }> {
  if (sampling || !schemaFileReady(TRADE_MEASUREMENT_MIGRATION)) return { watching: 0, finalized: 0 };
  sampling = true;
  let finalized = 0;
  try {
    const keys = await scanKeys(`${POST_EXIT_KEY_PREFIX}*`);
    const live = new Set<string>();
    for (const key of keys) {
      let stored: PostExitWatch | null = null;
      try {
        const raw = await redis.get(key);
        stored = raw ? (JSON.parse(raw) as PostExitWatch) : null;
      } catch {
        stored = null;
      }
      if (!stored) {
        await redis.del(key).catch(() => undefined);
        continue;
      }
      const mem = active.get(stored.signalId);
      let w = mem && mem.obs.total >= stored.obs.total ? mem : stored;

      if (now >= w.endAt) {
        try {
          await persistRecord(w, finalizePostExit(w));
          await redis.del(key);
          finalized++;
        } catch (err: any) {
          logger.warn({ error: err.message, signalId: w.signalId }, 'Post-exit tracker: final write failed — will retry');
          live.add(w.signalId);
          active.set(w.signalId, w);
        }
        continue;
      }

      try {
        const chain = await buildOptionChain(provider, w.symbol, w.exchange as Exchange, w.expiry ?? undefined);
        if (w.expiry == null || chain.expiry === w.expiry) {
          const leg = legOf(chain as any, w.strike, w.side);
          const ltp = leg && Number(leg.ltp) > 0 ? Number(leg.ltp) : null;
          // Re-read after the await: ticks may have folded in meanwhile.
          const cur = active.get(w.signalId);
          if (cur && cur.obs.total > w.obs.total) w = cur;
          w = foldPostExitObservation(w, { at: Date.now(), premium: ltp, underlying: chain.spotPrice ?? null, via: 'SWEEP' });
          if (leg?.token && w.token !== String(leg.token)) w = { ...w, token: String(leg.token) };
        }
      } catch (err: any) {
        logger.warn({ error: err.message, signalId: w.signalId }, 'Post-exit tracker: option chain fetch failed — this observation is missing');
      }
      active.set(w.signalId, w);
      live.add(w.signalId);
      if (w.token) byToken.set(w.token, w.signalId);
      await redis.set(key, JSON.stringify(w), 'EX', Math.max(3600, Math.ceil((w.endAt - now) / 1000) + 3600)).catch(() => undefined);
    }

    // Forget what has ended; keep the tick subscriptions to the live set.
    for (const id of [...active.keys()]) if (!live.has(id)) active.delete(id);
    for (const [token, id] of [...byToken.entries()]) if (!live.has(id)) byToken.delete(token);
    if (subscriptions) {
      const wanted = new Map<string, SubscriptionTarget>();
      for (const w of active.values()) if (w.token) wanted.set(w.token, { token: w.token, exchange: w.exchange as Exchange, exchangeSegment: FO_SEGMENT[w.exchange as Exchange] });
      const removed = [...subscribedTokens.entries()].filter(([t]) => !wanted.has(t)).map(([, v]) => v);
      const added = [...wanted.entries()].filter(([t]) => !subscribedTokens.has(t)).map(([, v]) => v);
      if (removed.length) {
        subscriptions.unsubscribe(TICK_CLIENT_ID, removed);
        for (const r of removed) subscribedTokens.delete(r.token);
      }
      if (added.length) {
        try {
          await subscriptions.subscribe(TICK_CLIENT_ID, added);
          for (const a of added) subscribedTokens.set(a.token, a);
        } catch (err: any) {
          logger.warn({ error: err.message, count: added.length }, 'Post-exit tracker: tick subscription failed — sweeps only');
        }
      }
    }
    return { watching: active.size, finalized };
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Post-exit tracker: sampling pass failed');
    return { watching: active.size, finalized };
  } finally {
    sampling = false;
  }
}
