// ============================================================
// FEED FRESHNESS — per-token data states and gap resolution (Phase 5)
// ============================================================
// Every token on the shared upstream tick feed has a state:
//
//   DATA_FRESH  ticks arriving (or the exchange is closed — no tick is due)
//   DATA_STALE  in session, no tick for FEED_STALE_MS
//   DATA_GAP    in session, no tick for FEED_GAP_MS, or the upstream socket
//               is down; gapStartedAt = the last tick before it
//   RECOVERING  the feed is back (reconnect / auth refresh) but the gap has
//               not been checked yet; leaves only through markRecovered
//
// Only the exchange session calendar decides "in session" (isMarketOpen):
// a quiet token after the close, on a weekend or a holiday is not a gap.
//
// Ticks are de-duplicated and ordered per token by the EXCHANGE timestamp
// (then the feed's sequence number): an exact repeat is dropped as a
// DUPLICATE, an older one as OUT_OF_ORDER — neither may move a price check.
//
// resolveGapTouch decides what happened at a level while the feed was away,
// from 1-minute bars covering the gap. It never assumes a fill: a touch it
// cannot sequence is FILL_UNCERTAIN, missing coverage that might hide a
// touch is MISSED_TOUCH_POSSIBLE.
//
// Pure: every function takes the clock as an argument.
// ============================================================

import { isMarketOpen, type Exchange, type InputQualityStatus, type Tick } from '@fno/shared';

export type FeedState = 'DATA_FRESH' | 'DATA_STALE' | 'DATA_GAP' | 'RECOVERING';

/** No tick for this long in session → DATA_STALE. */
export const FEED_STALE_MS = 2 * 60 * 1000;
/** No tick for this long in session → DATA_GAP. */
export const FEED_GAP_MS = 5 * 60 * 1000;

export interface TokenFeed {
  key: string;
  token: string;
  exchange: Exchange;
  state: FeedState;
  /** Exchange timestamp of the newest accepted tick. */
  lastTickTime: number | null;
  /** Arrival time of the newest accepted tick (the last successful quote). */
  lastSuccessfulQuoteTime: number | null;
  lastSequence: number | null;
  lastLtp: number | null;
  /** When the current / last gap began (the last good tick before it). */
  gapStartedAt: number | null;
  /** Length of the current gap (open) or of the last one (closed). */
  gapDurationMs: number | null;
  /** When the feed came back for the gap being recovered. */
  recoveringSince: number | null;
  /** The last gap check's outcome (surfaced in health and diagnostics). */
  lastGapOutcome: { at: number; outcome: string; detail: string } | null;
  droppedDuplicates: number;
  droppedOutOfOrder: number;
}

/** A token's state in the Phase 2 data-quality vocabulary. */
export interface TokenFeedView {
  token: string;
  exchange: Exchange;
  state: FeedState;
  lastTickTime: number | null;
  lastSuccessfulQuoteTime: number | null;
  gapDurationMs: number | null;
  /** = lastTickTime (null without a tick). */
  asOf: number | null;
  source: string;
  status: InputQualityStatus;
  lastGapOutcome: TokenFeed['lastGapOutcome'];
}

export type TickVerdict = { accept: true } | { accept: false; reason: 'DUPLICATE' | 'OUT_OF_ORDER' };

const statusOf = (s: FeedState, hasTick: boolean): InputQualityStatus =>
  !hasTick ? 'MISSING' : s === 'DATA_FRESH' ? 'OK' : 'STALE_INPUT';

export class FeedTracker {
  private feeds = new Map<string, TokenFeed>();
  private upstreamDown: { since: number } | null = null;
  partialBatches = 0;
  lastPartialBatchAt: number | null = null;

  constructor(private readonly source = 'angel-one:ws') {}

  /** Starts tracking a token (idempotent). */
  track(key: string, token: string, exchange: Exchange): void {
    if (this.feeds.has(key)) return;
    this.feeds.set(key, {
      key, token, exchange, state: 'DATA_FRESH', lastTickTime: null, lastSuccessfulQuoteTime: null, lastSequence: null, lastLtp: null,
      gapStartedAt: null, gapDurationMs: null, recoveringSince: null, lastGapOutcome: null, droppedDuplicates: 0, droppedOutOfOrder: 0,
    });
  }

  untrack(key: string): void {
    this.feeds.delete(key);
  }

  get(key: string): TokenFeed | undefined {
    return this.feeds.get(key);
  }

  /** The state of every key tracking this token (a token can sit under more than one segment key). */
  stateOfToken(token: string): FeedState | null {
    let worst: FeedState | null = null;
    const rank: Record<FeedState, number> = { DATA_FRESH: 0, RECOVERING: 1, DATA_STALE: 2, DATA_GAP: 3 };
    for (const f of this.feeds.values()) if (f.token === token && (worst == null || rank[f.state] > rank[worst])) worst = f.state;
    return worst;
  }

  /**
   * One tick for a key: accept it (and refresh the token) unless it repeats
   * or predates the newest accepted tick, by exchange timestamp then sequence.
   * A tick never ends RECOVERING — only the gap check does (markRecovered).
   */
  acceptTick(key: string, tick: Pick<Tick, 'ltp' | 'timestamp'> & { exchangeTimestamp?: number; sequence?: number }, now: number): TickVerdict {
    const f = this.feeds.get(key);
    if (!f) return { accept: true };
    const ts = tick.exchangeTimestamp ?? null;
    const seq = tick.sequence ?? null;
    if (ts != null && f.lastTickTime != null) {
      if (ts < f.lastTickTime || (ts === f.lastTickTime && seq != null && f.lastSequence != null && seq < f.lastSequence)) {
        f.droppedOutOfOrder++;
        return { accept: false, reason: 'OUT_OF_ORDER' };
      }
      if (ts === f.lastTickTime && (seq == null || f.lastSequence == null || seq === f.lastSequence) && tick.ltp === f.lastLtp) {
        f.droppedDuplicates++;
        return { accept: false, reason: 'DUPLICATE' };
      }
    }
    f.lastTickTime = ts ?? now;
    f.lastSequence = seq;
    f.lastLtp = tick.ltp;
    f.lastSuccessfulQuoteTime = now;
    if (f.state === 'DATA_STALE') f.state = 'DATA_FRESH';
    else if (f.state === 'DATA_GAP') {
      // Ticks are back without a reconnect (a quiet spell): the gap still has to be checked.
      f.gapDurationMs = now - (f.gapStartedAt ?? now);
      f.state = 'RECOVERING';
      f.recoveringSince = now;
    }
    return { accept: true };
  }

  /** A batch had a truncated / unknown packet: counted and surfaced (its complete ticks are still used). */
  flagPartialBatch(now: number): void {
    this.partialBatches++;
    this.lastPartialBatchAt = now;
  }

  /** The upstream socket dropped: every in-session token is in a gap from its last tick. */
  markUpstreamDown(now: number): void {
    this.upstreamDown ??= { since: now };
    for (const f of this.feeds.values()) {
      if (!isMarketOpen(f.exchange, now) || f.state === 'RECOVERING') continue;
      if (f.state !== 'DATA_GAP') f.gapStartedAt = f.lastSuccessfulQuoteTime ?? now;
      f.state = 'DATA_GAP';
    }
  }

  /**
   * The feed is back (reconnect / new connection after an auth refresh): each
   * token that was in a gap — or every token, `all` — is RECOVERING until its
   * gap is checked. Returns the gaps to check: [from, to] per key.
   */
  markRecovering(now: number, all = false): Array<{ key: string; token: string; exchange: Exchange; from: number; to: number }> {
    const down = this.upstreamDown;
    this.upstreamDown = null;
    const out: Array<{ key: string; token: string; exchange: Exchange; from: number; to: number }> = [];
    for (const f of this.feeds.values()) {
      const inGap = f.state === 'DATA_GAP' || f.state === 'DATA_STALE';
      if (!inGap && !all) continue;
      const from = f.gapStartedAt ?? f.lastSuccessfulQuoteTime ?? down?.since ?? now;
      f.gapStartedAt = from;
      f.gapDurationMs = now - from;
      f.state = 'RECOVERING';
      f.recoveringSince = now;
      out.push({ key: f.key, token: f.token, exchange: f.exchange, from, to: now });
    }
    return out;
  }

  /** The gap was checked: the token is fresh again, with the outcome on record. */
  markRecovered(key: string, outcome: string, detail: string, now: number): void {
    const f = this.feeds.get(key);
    if (!f) return;
    f.lastGapOutcome = { at: now, outcome, detail };
    f.state = 'DATA_FRESH';
    f.recoveringSince = null;
  }

  /** Time-driven transitions (call on a timer): STALE / GAP while in session and silent; out of session nothing is due. */
  evaluate(now: number): void {
    for (const f of this.feeds.values()) {
      if (f.state === 'RECOVERING') continue;
      if (!isMarketOpen(f.exchange, now)) {
        // No tick is due outside the session: a quiet token is fresh, and an open gap ends at the close.
        if (f.state === 'DATA_STALE') f.state = 'DATA_FRESH';
        continue;
      }
      if (this.upstreamDown) continue;
      const last = f.lastSuccessfulQuoteTime;
      if (last == null) continue;
      const silent = now - last;
      if (silent >= FEED_GAP_MS) {
        if (f.state !== 'DATA_GAP') f.gapStartedAt = last;
        f.state = 'DATA_GAP';
        f.gapDurationMs = now - (f.gapStartedAt ?? last);
      } else if (silent >= FEED_STALE_MS && f.state === 'DATA_FRESH') {
        f.state = 'DATA_STALE';
      }
    }
  }

  isUpstreamDown(): boolean {
    return this.upstreamDown != null;
  }

  view(now: number): TokenFeedView[] {
    return [...this.feeds.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((f) => ({
        token: f.token,
        exchange: f.exchange,
        state: f.state,
        lastTickTime: f.lastTickTime,
        lastSuccessfulQuoteTime: f.lastSuccessfulQuoteTime,
        gapDurationMs: f.state === 'DATA_GAP' && f.gapStartedAt != null ? now - f.gapStartedAt : f.gapDurationMs,
        asOf: f.lastTickTime,
        source: this.source,
        status: statusOf(f.state, f.lastTickTime != null),
        lastGapOutcome: f.lastGapOutcome,
      }));
  }

  summary(now: number): { tokens: number; byState: Record<FeedState, number>; upstreamDown: boolean; partialBatches: number; lastPartialBatchAt: number | null; droppedDuplicates: number; droppedOutOfOrder: number } {
    const byState: Record<FeedState, number> = { DATA_FRESH: 0, DATA_STALE: 0, DATA_GAP: 0, RECOVERING: 0 };
    let dup = 0;
    let ooo = 0;
    for (const f of this.feeds.values()) {
      byState[f.state]++;
      dup += f.droppedDuplicates;
      ooo += f.droppedOutOfOrder;
    }
    void now;
    return { tokens: this.feeds.size, byState, upstreamDown: this.upstreamDown != null, partialBatches: this.partialBatches, lastPartialBatchAt: this.lastPartialBatchAt, droppedDuplicates: dup, droppedOutOfOrder: ooo };
  }
}

// ---------------- gap resolution ----------------

export interface GapBar {
  /** Bar open time (epoch ms). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * NO_TOUCH               the bars cover the gap and no level was reached
 * LEVEL_TOUCHED          the bars cover the gap and the FIRST level reached is
 *                        known (sequence established) — resolve normally
 * FILL_UNCERTAIN         two levels were reached inside the same bar — the
 *                        order cannot be established; nothing is assumed
 * MISSED_TOUCH_POSSIBLE  the bars do not cover the gap (missing minutes), or
 *                        none were returned, and a level could have been
 *                        reached in the missing part — nothing is assumed
 */
export type GapOutcome = 'NO_TOUCH' | 'LEVEL_TOUCHED' | 'FILL_UNCERTAIN' | 'MISSED_TOUCH_POSSIBLE';

export interface GapLevel {
  name: string;
  price: number;
  /** ABOVE: reached when high ≥ price; BELOW: when low ≤ price. */
  side: 'ABOVE' | 'BELOW';
}

/**
 * Pure: what happened at the given levels between `from` and `to`, from
 * 1-minute bars. Sequence across bars is established by bar order; inside one
 * bar it is not — two levels in one bar is FILL_UNCERTAIN. Any minute of the
 * gap without a bar is a coverage hole: if no covered bar reached a level,
 * the hole could hide one (MISSED_TOUCH_POSSIBLE).
 */
export function resolveGapTouch(args: { bars: readonly GapBar[]; from: number; to: number; levels: readonly GapLevel[]; barMs?: number }): { outcome: GapOutcome; level: GapLevel | null; at: number | null; detail: string } {
  const barMs = args.barMs ?? 60_000;
  const firstMinute = Math.floor(args.from / barMs) * barMs;
  const bars = [...args.bars].filter((b) => b.time + barMs > args.from && b.time < args.to).sort((a, b) => a.time - b.time);
  const reached = (b: GapBar, l: GapLevel) => (l.side === 'ABOVE' ? b.high >= l.price : b.low <= l.price);
  for (const b of bars) {
    const hit = args.levels.filter((l) => reached(b, l));
    if (hit.length > 1) return { outcome: 'FILL_UNCERTAIN', level: null, at: b.time, detail: `${hit.map((l) => l.name).join(' and ')} both inside the ${new Date(b.time).toISOString()} minute — order unknown.` };
    if (hit.length === 1) return { outcome: 'LEVEL_TOUCHED', level: hit[0], at: b.time, detail: `${hit[0].name} (${hit[0].price}) reached first, in the ${new Date(b.time).toISOString()} minute.` };
  }
  const expected = Math.max(0, Math.ceil((args.to - firstMinute) / barMs));
  const covered = new Set(bars.map((b) => Math.floor(b.time / barMs))).size;
  if (covered < expected) return { outcome: 'MISSED_TOUCH_POSSIBLE', level: null, at: null, detail: `Only ${covered} of ${expected} gap minutes have bars — a level may have been reached in the missing ones.` };
  return { outcome: 'NO_TOUCH', level: null, at: null, detail: `No level reached in ${covered} minute(s) of the gap.` };
}
