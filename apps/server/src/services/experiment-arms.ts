// ============================================================
// ISOLATED PAPER EXPERIMENTS — pure core (EXP-2.0, 2026-10-23)
// ============================================================
// Every arm consumes the SAME Old Indicator candidate stream (one candidate per
// poll of a symbol, built side-effect free by market-bias's own indicator
// builder, whether or not the production slot is free) and keeps its OWN state:
// positions, one slot per symbol+mode, its own post-loss cooldowns, its own
// parent bookkeeping and exits. Nothing here is read by the production baseline;
// nothing here reaches a broker. Paper only, never promoted automatically.
//
// Arms (Old Indicator INTRADAY only — never positional, never another strategy):
//   R0  CONTROL_REPLICA  the baseline's own rules inside this engine. Arms are
//                        compared with R0, never with production, so the
//                        engine's own implementation is held constant.
//   A   FILTER_CONTROL   R0 + planned target >= 0.5R
//   B   FILTER_CONTROL   R0 + no NSE/BSE entry >= 240 min after the open
//   C   FILTER_CONTROL   A and B — EXPLORATORY (thresholds chosen after viewing 5-22 Oct)
//   V2  HYPOTHESIS       R0 + structural invalidation exit (IND-V2-INVALIDATION-1.0):
//        Observed: the final stop is the 30% premium floor in 95% of intraday trades
//        (median 2.81 underlying ATR) while the structural level behind price is a
//        median 0.79 ATR away; structure can only WIDEN the stop
//        (trade-setup/index.ts: stop = min(max(base, structural), cap)). Trades whose
//        underlying crossed that level (217 of 615, sampled MAE) lost -89.4R, only 40
//        recovered to target, median option MFE +0.10R.
//        Rule: exit (market) when a closed 15-minute bar closes beyond
//        behindLevel -/+ 0.25 x ATR-at-entry against the trade. Entry, contract,
//        initial stop (so R and cost R), target, trailing and all other exits unchanged.
//        Downside: it also cuts trades that recover (40 of 217 reached target), and a
//        closing-bar rule exits later and worse than the level itself. Unproven.
//
// Two ledgers per position, never mixed:
//   OFFICIAL  the production fill policy (FILL-1.0): entry at the decision mid,
//             a target at min(LTP, target) once LTP reaches it, other exits at the
//             observed LTP, official cost model in R.
//   SIMULATED quote-based estimates, not fills: entry at the ask; a resting limit
//             target only when the BID reached the target; market exits at the bid.
//             Every fill needs a fresh two-sided quote (exchange age <= 60 s, or a
//             receipt <= 15 s old when the exchange time is unknown) and top-of-book
//             quantity >= the position's quantity (1 lot). Otherwise the position
//             stays open (or exit-pending) and keeps observing; at the session end a
//             still-unfilled exit is UNRESOLVED, never an invented fill. Fees only
//             (statutory + brokerage); the spread is in the prices.
// ============================================================

import { bookUnit } from './book-units.js';

export const EXPERIMENTS_VERSION = 'EXP-3.1';
export type ArmId = 'R0' | 'A' | 'B' | 'C' | 'V2' | 'A3R' | 'OF1R';
/** Which candidate stream an arm consumes. */
export type ArmSource = 'INDICATOR' | 'A3' | 'OF1';
export type ArmKind = 'CONTROL_REPLICA' | 'FILTER_CONTROL' | 'HYPOTHESIS';

export interface ExpQuote {
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  exchangeAt: number | null;
  receivedAt: number;
  feedState: string | null;
  source: string;
}

export interface ExpCandidate {
  at: number;
  candidateId: string;
  symbol: string;
  exchange: 'NSE' | 'BSE' | 'MCX';
  mode: 'INTRADAY' | 'POSITIONAL';
  direction: 'BULLISH' | 'BEARISH';
  confidence: number;
  side: 'CE' | 'PE';
  strike: number;
  expiry: string;
  token: string | null;
  lotSize: number;
  entry: number;
  stop: number;
  target: number;
  costPct: number;
  statutoryPct: number;
  brokeragePerLotInr: number;
  minutesSinceOpen: number | null;
  behindLevel: number | null;
  /** The kind of that level (location-quality StructuralLevel kind): with its price, the setup's identity for V2 1.1. */
  behindKind?: string | null;
  atr: number | null;
  quote: ExpQuote;
  /** Trigger-family candidates only: the trigger, and the sweep extreme its SWEEP_RECLAIMED exit reads. */
  triggerId?: string;
  sweepExtreme?: number | null;
  /** Recorded for the forward comparison only (no arm rule reads them): the decision bar, the underlying R to T1,
   *  the router's bucket, and the router's OBSERVATION arbitration role (A3 only; null for OF1, whose candidates carry
   *  none). Production's final selection is slot arbitration, later in the poll: join production trades on candidateId. */
  decisionTime?: number;
  rToT1?: number | null;
  bucket?: string;
  arbitrationRole?: string | null;
}

export interface ArmDef {
  id: ArmId;
  version: string;
  kind: ArmKind;
  exploratory: boolean;
  description: string;
  invalidationExit: boolean;
  /** EXP-3.0: the candidate stream; the exits of that stream's production chain. */
  source: ArmSource;
  /** Bias-reversal exit (the Old Indicator's); trigger-family trades never have it in production. */
  biasReversalExit: boolean;
  /** SWEEP_RECLAIMED exit (a closed 15m bar back beyond the sweep extreme) — the trigger families' structural exit. */
  structureExit: boolean;
  /** TRIGGER_REVERSAL exit (momentum-break-live.ts triggerSlotAction): a fresh trigger the other way, claimed this poll. */
  triggerReversalExit: boolean;
  /** V2 1.1: an entry leaning on a level its own invalidation exit broke is refused until a close reclaims that level. */
  blockInvalidatedSetup?: boolean;
  /** A skip code when the arm's ENTRY rule refuses the candidate, else null. */
  entryRule: (c: ExpCandidate) => string | null;
}

export const plannedTargetR = (c: Pick<ExpCandidate, 'entry' | 'stop' | 'target'>): number | null =>
  c.entry > c.stop ? (c.target - c.entry) / (c.entry - c.stop) : null;
const lateNseBse = (c: ExpCandidate) => c.exchange !== 'MCX' && c.minutesSinceOpen != null && c.minutesSinceOpen >= 240;
const ruleA = (c: ExpCandidate) => ((plannedTargetR(c) ?? -1) >= 0.5 ? null : 'TARGET_BELOW_0_5R');
const ruleB = (c: ExpCandidate) => (lateNseBse(c) ? 'LATE_NSE_BSE_ENTRY' : null);

export const ARMS: readonly ArmDef[] = Object.freeze([
  { id: 'R0', version: 'R0-REPLICA-1.0', kind: 'CONTROL_REPLICA', exploratory: false, invalidationExit: false, source: 'INDICATOR', biasReversalExit: true, structureExit: false, triggerReversalExit: false, description: 'Baseline Old Indicator intraday rules, inside the experiment engine (control).', entryRule: () => null },
  { id: 'A', version: 'A-TARGET-0.5R-1.0', kind: 'FILTER_CONTROL', exploratory: false, invalidationExit: false, source: 'INDICATOR', biasReversalExit: true, structureExit: false, triggerReversalExit: false, description: 'R0 + planned target >= 0.5R.', entryRule: ruleA },
  { id: 'B', version: 'B-NO-LATE-NSE-1.0', kind: 'FILTER_CONTROL', exploratory: false, invalidationExit: false, source: 'INDICATOR', biasReversalExit: true, structureExit: false, triggerReversalExit: false, description: 'R0 + no NSE/BSE entry 240+ min after the open.', entryRule: ruleB },
  { id: 'C', version: 'C-A-AND-B-1.0', kind: 'FILTER_CONTROL', exploratory: true, invalidationExit: false, source: 'INDICATOR', biasReversalExit: true, structureExit: false, triggerReversalExit: false, description: 'A and B (exploratory).', entryRule: (c) => ruleA(c) ?? ruleB(c) },
  // IND-V2-INVALIDATION-1.1 (2026-10-23): an invalidation exit retires its SETUP (direction + the structural level it
  // leaned on): a later entry leaning on that same level is refused until a closed 15m bar closes back on the trade side
  // of it. 1.0 could re-enter on the very level it had just declared broken (NATURALGAS 260, 23 Oct, 39 min later).
  // A fresh level behind price is a different setup and is not blocked. No cooldown; every other rule unchanged.
  { id: 'V2', version: 'IND-V2-INVALIDATION-1.1', kind: 'HYPOTHESIS', exploratory: false, invalidationExit: true, blockInvalidatedSetup: true, source: 'INDICATOR', biasReversalExit: true, structureExit: false, triggerReversalExit: false, description: 'R0 + exit when a closed 15m bar closes beyond the structural level behind (+0.25 ATR); that setup (direction + level) is not re-entered until a close reclaims the level.', entryRule: () => null },
  // EXP-3.0 (2026-10-23): capture arms for the trigger families. No V2 rule: the evidence did not support one
  // (analysis/a3-of1-2026-10-23). They take EVERY production paper-stage candidate of their trigger, including those
  // that lose slot arbitration or meet a held production slot, so option-level outcomes exist for all of them.
  // EXP-3.1 (2026-10-23): 1.1 adds production's TRIGGER_REVERSAL exit, which 1.0 omitted (an unintended difference).
  { id: 'A3R', version: 'A3-R0-1.1', kind: 'CONTROL_REPLICA', exploratory: false, invalidationExit: false, source: 'A3', biasReversalExit: false, structureExit: true, triggerReversalExit: true, description: 'A3 as routed by production (all paper-stage candidates), with its own slot, cooldowns and exits, including TRIGGER_REVERSAL.', entryRule: () => null },
  { id: 'OF1R', version: 'OF1-R0-1.1', kind: 'CONTROL_REPLICA', exploratory: false, invalidationExit: false, source: 'OF1', biasReversalExit: false, structureExit: true, triggerReversalExit: true, description: 'OF1 as routed by production (all paper-stage candidates), with its own slot, cooldowns and exits, including TRIGGER_REVERSAL.', entryRule: () => null },
]);

/**
 * Superseded arm versions, kept as activated: a position opened under one finishes under its rules. They take no new
 * candidate (not in ARMS).
 */
export const RETIRED_ARMS: readonly ArmDef[] = Object.freeze([
  { id: 'V2', version: 'IND-V2-INVALIDATION-1.0', kind: 'HYPOTHESIS', exploratory: false, invalidationExit: true, source: 'INDICATOR', biasReversalExit: true, structureExit: false, triggerReversalExit: false, description: 'R0 + exit when a closed 15m bar closes beyond the structural level behind (+0.25 ATR).', entryRule: () => null },
  { id: 'A3R', version: 'A3-R0-1.0', kind: 'CONTROL_REPLICA', exploratory: false, invalidationExit: false, source: 'A3', biasReversalExit: false, structureExit: true, triggerReversalExit: false, description: 'A3 as routed by production (all paper-stage candidates), with its own slot, cooldowns and exits.', entryRule: () => null },
  { id: 'OF1R', version: 'OF1-R0-1.0', kind: 'CONTROL_REPLICA', exploratory: false, invalidationExit: false, source: 'OF1', biasReversalExit: false, structureExit: true, triggerReversalExit: false, description: 'OF1 as routed by production (all paper-stage candidates), with its own slot, cooldowns and exits.', entryRule: () => null },
]);

/** The definition a position was opened under (its own version), else null. */
export function armFor(id: string, version: string): ArmDef | null {
  return ARMS.find((a) => a.id === id && a.version === version) ?? RETIRED_ARMS.find((a) => a.id === id && a.version === version) ?? null;
}

// ---------------- the arm's own cooldowns (the baseline's rules, the arm's own losses) ----------------
// market-bias.ts losingCloseCooldownReason / registerLosingClose, replicated on the arm's state.
export const COOLDOWN = Object.freeze({ settleMinutes: 15, dayLossMinConfidence: 80, sameSideMinutes: 60, maxSameDirectionLossesPerDay: 2 });

export interface ArmLoss {
  at: number;
  day: string;
  exchange: string;
  symbol: string;
  mode: string;
  direction: string;
  positionId: string;
}

export function armCooldownCode(losses: readonly ArmLoss[], c: Pick<ExpCandidate, 'exchange' | 'symbol' | 'mode' | 'direction' | 'confidence'>, now: number, day: string): string | null {
  const ex = losses.filter((l) => l.exchange === c.exchange && l.mode === c.mode);
  if (ex.some((l) => now - l.at < COOLDOWN.settleMinutes * 60_000)) return 'POST_LOSS_COOLDOWN';
  if (ex.some((l) => l.day === day) && c.confidence < COOLDOWN.dayLossMinConfidence) return 'POST_LOSS_COOLDOWN';
  const same = ex.filter((l) => l.symbol === c.symbol && l.direction === c.direction);
  if (same.filter((l) => l.day === day).length >= COOLDOWN.maxSameDirectionLossesPerDay) return 'DIRECTION_LOCKED';
  if (same.some((l) => now - l.at < COOLDOWN.sameSideMinutes * 60_000)) return 'SAME_SYMBOL_SIDE';
  return null;
}

// ---------------- positions: two ledgers ----------------

export type SimStatus = 'NOT_OPENED' | 'OPEN' | 'EXIT_PENDING' | 'CLOSED' | 'UNRESOLVED';
export type FillBasis = 'MARKETABLE_ASK' | 'MARKETABLE_BID' | 'RESTING_LIMIT_BID_REACHED' | 'NONE';

export interface ArmPosition {
  id: string;
  arm: ArmId;
  armVersion: string;
  /** Simulated-ledger version (absent = SIM-1.0: MCX sizes read as units, session end on the last quote only). */
  simVersion?: string;
  candidate: ExpCandidate;
  openedAt: number;
  initialStop: number;
  stop: number;
  target: number;
  quantity: number;
  lastQuote: ExpQuote | null;
  /** The last two-sided quote (SIM-1.1): what a session-end fill may use when the last quote is a book-less tick. */
  lastBookQuote?: ExpQuote | null;
  observations: number;
  reversal: { streak: number; since: number | null };
  official: { status: 'OPEN' | 'CLOSED'; exitAt: number | null; exitPrice: number | null; reason: string | null; netR: number | null };
  sim: {
    status: SimStatus;
    entryPrice: number | null;
    entryQuality: string | null;
    pendingReason: string | null;
    pendingSince: number | null;
    exitAt: number | null;
    exitPrice: number | null;
    exitBasis: FillBasis;
    exitQuality: string | null;
    reason: string | null;
    netR: number | null;
    lastValidBid: number | null;
    /** SIM-1.1: why each quote seen while EXIT_PENDING could not fill, counted by reason and quote source. */
    pendingBlocks?: Record<string, number>;
  };
}

export const MAX_EXCHANGE_AGE_MS = 60_000;
export const MAX_RECEIPT_AGE_MS = 15_000;
export const TRAIL_BREAKEVEN_AT_R = 1;
export const TRAIL_LOCK_AT_R = 2;

/** Pure: why a quote cannot support a fill of `quantity` on `side`, or null when it can. */
/** SIM-1.1 (2026-10-23): MCX book sizes in units (paper-execution-ledger bookUnit); session end reads the last two-sided quote. */
export const SIM_VERSION = 'SIM-1.1';
const unitOf = (c: ExpCandidate) => bookUnit(c.exchange, c.lotSize);

export function fillBlocker(q: ExpQuote | null, side: 'BUY' | 'SELL', quantity: number, now: number, unit = 1): string | null {
  if (!q) return 'NO_QUOTE';
  if (q.bid == null || q.ask == null || !(q.bid > 0) || !(q.ask >= q.bid)) return 'ONE_SIDED_OR_NO_QUOTE';
  if (q.feedState != null && q.feedState !== 'DATA_FRESH') return 'FEED_NOT_FRESH';
  if (q.exchangeAt != null) {
    if (now - q.exchangeAt > MAX_EXCHANGE_AGE_MS) return 'STALE_QUOTE';
  } else if (now - q.receivedAt > MAX_RECEIPT_AGE_MS) return 'STALE_QUOTE_AGE_UNKNOWN';
  const top = side === 'BUY' ? q.askQty : q.bidQty;
  if (top == null) return 'SIZE_UNKNOWN';
  if (top * unit < quantity) return 'SIZE_INSUFFICIENT';
  return null;
}

export function openPosition(arm: ArmDef, c: ExpCandidate, id: string, now: number): ArmPosition {
  const qty = c.lotSize;
  const block = fillBlocker(c.quote, 'BUY', qty, now, unitOf(c));
  return {
    id,
    arm: arm.id,
    armVersion: arm.version,
    simVersion: SIM_VERSION,
    candidate: c,
    openedAt: now,
    initialStop: c.stop,
    stop: c.stop,
    target: c.target,
    quantity: qty,
    lastQuote: c.quote,
    observations: 1,
    reversal: { streak: 0, since: null },
    official: { status: 'OPEN', exitAt: null, exitPrice: null, reason: null, netR: null },
    sim: {
      status: block ? 'NOT_OPENED' : 'OPEN',
      entryPrice: block ? null : c.quote.ask,
      entryQuality: block ?? 'OK',
      pendingReason: null,
      pendingSince: null,
      exitAt: null,
      exitPrice: null,
      exitBasis: 'NONE',
      exitQuality: null,
      reason: block ? `ENTRY_UNAVAILABLE:${block}` : null,
      netR: null,
      lastValidBid: null,
    },
  };
}

const risk = (p: ArmPosition) => p.candidate.entry - p.initialStop;

/** Official net R exactly as backtesting.ts: return % less the estimated cost %, over the original risk %. */
export function officialNetR(p: ArmPosition, exit: number): number {
  const e = p.candidate.entry;
  return ((exit - e) / e * 100 - p.candidate.costPct) / ((e - p.initialStop) / e * 100);
}

/** Simulated net R: (bid/target exit - ask entry - fees) over the same original risk. Fees only: statutory + brokerage. */
export function simNetR(p: ArmPosition, exit: number): number | null {
  if (p.sim.entryPrice == null) return null;
  const fees = (p.candidate.entry * p.candidate.statutoryPct) / 100 + p.candidate.brokeragePerLotInr / p.quantity;
  return (exit - p.sim.entryPrice - fees) / risk(p);
}

function closeOfficial(p: ArmPosition, at: number, price: number, reason: string): void {
  if (p.official.status !== 'OPEN') return;
  p.official = { status: 'CLOSED', exitAt: at, exitPrice: price, reason, netR: officialNetR(p, price) };
}

function setPending(p: ArmPosition, at: number, reason: string): void {
  if (p.sim.status === 'OPEN') {
    p.sim.status = 'EXIT_PENDING';
    p.sim.pendingReason = reason;
    p.sim.pendingSince = at;
  }
}

function tryFillPending(p: ArmPosition, q: ExpQuote, now: number): void {
  if (p.sim.status !== 'EXIT_PENDING') return;
  const block = fillBlocker(q, 'SELL', p.quantity, now, unitOf(p.candidate));
  if (block) {
    p.sim.exitQuality = block;
    const k = `${q.source}:${block}`;
    p.sim.pendingBlocks = { ...(p.sim.pendingBlocks ?? {}), [k]: (p.sim.pendingBlocks?.[k] ?? 0) + 1 };
    return;
  }
  p.sim.status = 'CLOSED';
  p.sim.exitAt = now;
  p.sim.exitPrice = q.bid;
  p.sim.exitBasis = 'MARKETABLE_BID';
  p.sim.exitQuality = 'OK';
  p.sim.reason = p.sim.pendingReason;
  p.sim.netR = simNetR(p, q.bid!);
}

/** Stop reason by where the (trailed) stop sits — market-bias.ts closeReasonForPriceHit. */
const stopReason = (p: ArmPosition) => (p.stop > p.candidate.entry ? 'TRAILING_STOP' : p.stop === p.candidate.entry ? 'BREAKEVEN_STOP' : 'STOP_LOSS');

/**
 * Pure: one observed quote of the position's own contract. Trailing and the
 * official exits read the LTP (as production does); the simulated ledger needs
 * the book. Returns the events it produced.
 */
export function onQuote(p: ArmPosition, q: ExpQuote, now: number): string[] {
  const ev: string[] = [];
  p.lastQuote = q;
  p.observations += 1;
  if (q.bid != null && q.bid > 0 && !fillBlocker(q, 'SELL', p.quantity, now, unitOf(p.candidate))) p.sim.lastValidBid = q.bid;
  if (q.bid != null && q.ask != null) p.lastBookQuote = q; // ticks carry no book: keep the last two-sided quote apart
  const ltp = q.ltp;
  if (ltp != null && ltp > 0 && (p.official.status === 'OPEN' || p.sim.status === 'OPEN' || p.sim.status === 'EXIT_PENDING')) {
    // Trailing (market-bias.ts): +1R -> breakeven, +2R -> entry + 1R; never loosens.
    const r = risk(p);
    if (r > 0) {
      const profit = ltp - p.candidate.entry;
      const next = profit >= TRAIL_LOCK_AT_R * r ? p.candidate.entry + r : profit >= TRAIL_BREAKEVEN_AT_R * r ? p.candidate.entry : p.stop;
      if (next > p.stop) {
        p.stop = next;
        ev.push('STOP_TRAILED');
      }
    }
    if (p.official.status === 'OPEN') {
      if (ltp >= p.target) {
        closeOfficial(p, now, Math.min(ltp, p.target), 'TARGET');
        ev.push('OFFICIAL_TARGET');
      } else if (ltp <= p.stop) {
        const reason = stopReason(p);
        closeOfficial(p, now, ltp, reason);
        ev.push(`OFFICIAL_${reason}`);
      }
    }
  }
  if (p.sim.status === 'OPEN') {
    // Resting limit at the target: a buyer must bid it, with the size.
    if (q.bid != null && q.bid >= p.target && !fillBlocker(q, 'SELL', p.quantity, now, unitOf(p.candidate))) {
      p.sim.status = 'CLOSED';
      p.sim.exitAt = now;
      p.sim.exitPrice = p.target;
      p.sim.exitBasis = 'RESTING_LIMIT_BID_REACHED';
      p.sim.exitQuality = 'OK';
      p.sim.reason = 'TARGET';
      p.sim.netR = simNetR(p, p.target);
      ev.push('SIM_TARGET');
    } else if (ltp != null && ltp > 0 && ltp <= p.stop) {
      // A stop-market order triggers on the traded price and fills at the bid.
      setPending(p, now, stopReason(p));
      ev.push('SIM_STOP_TRIGGERED');
    }
  }
  if (p.sim.status === 'EXIT_PENDING') {
    tryFillPending(p, q, now);
    if ((p.sim.status as SimStatus) === 'CLOSED') ev.push('SIM_EXIT_FILLED');
  }
  return ev;
}

export interface DecisionRead {
  at: number;
  direction: string;
  confidence: number;
  minConfidence: number;
  confirmMs: number;
  /** The newest CLOSED 15-minute bar's close and its close time, when known. */
  lastClosedBar: { close: number; closeAt: number } | null;
  /** Fresh triggers production claims this poll (each counted once, as its claim): TRIGGER_REVERSAL reads them. */
  freshTriggers?: readonly { direction: string }[];
}

/** Pure: a later bias read of the same symbol+mode — reversal exits for every arm, the invalidation exit for V2. */
export function onDecisionRead(p: ArmPosition, arm: ArmDef, d: DecisionRead): string[] {
  const ev: string[] = [];
  const live = p.official.status === 'OPEN' || p.sim.status === 'OPEN';
  if (!live) return ev;
  const ltp = p.lastQuote?.ltp ?? null;
  const exitBoth = (reason: string) => {
    if (p.official.status === 'OPEN' && ltp != null && ltp > 0) {
      closeOfficial(p, d.at, ltp, reason);
      ev.push(`OFFICIAL_${reason}`);
    }
    if (p.sim.status === 'OPEN') {
      setPending(p, d.at, reason);
      ev.push(`SIM_${reason}_PENDING`);
      if (p.lastQuote) tryFillPending(p, p.lastQuote, d.at);
      if ((p.sim.status as SimStatus) === 'CLOSED') ev.push('SIM_EXIT_FILLED');
    }
  };
  // V2: a closed 15m bar beyond the structural level behind price, against the trade.
  if (arm.invalidationExit && d.lastClosedBar && d.lastClosedBar.closeAt > p.openedAt && p.candidate.behindLevel != null && p.candidate.atr != null) {
    const buffer = 0.25 * p.candidate.atr;
    const broken = p.candidate.direction === 'BULLISH' ? d.lastClosedBar.close < p.candidate.behindLevel - buffer : d.lastClosedBar.close > p.candidate.behindLevel + buffer;
    if (broken) {
      exitBoth('STRUCTURE_INVALIDATED');
      return ev;
    }
  }
  // Trigger families (momentum-break-live.ts triggerSlotAction): a closed bar back beyond the sweep extreme.
  if (arm.structureExit && d.lastClosedBar && d.lastClosedBar.closeAt > p.openedAt && p.candidate.sweepExtreme != null) {
    const reclaimed = p.candidate.direction === 'BEARISH' ? d.lastClosedBar.close > p.candidate.sweepExtreme : d.lastClosedBar.close < p.candidate.sweepExtreme;
    if (reclaimed) {
      exitBoth('SWEEP_RECLAIMED');
      return ev;
    }
  }
  // Production checks it after SWEEP_RECLAIMED: any fresh trigger the other way closes the held trade.
  if (arm.triggerReversalExit && (p.candidate.direction === 'BULLISH' || p.candidate.direction === 'BEARISH') && (d.freshTriggers ?? []).some((t) => t.direction !== p.candidate.direction)) {
    exitBoth('TRIGGER_REVERSAL');
    return ev;
  }
  if (!arm.biasReversalExit) return ev;
  // Bias reversal (market-bias.ts): a confident opposite read, confirmed over 2 reads and the confirm window.
  const opposite = d.direction !== p.candidate.direction && (d.direction === 'BULLISH' || d.direction === 'BEARISH') && d.confidence >= d.minConfidence;
  if (d.direction === p.candidate.direction) p.reversal = { streak: 0, since: null };
  else if (opposite) {
    const since = p.reversal.since ?? d.at;
    const streak = p.reversal.streak + 1;
    p.reversal = { streak, since };
    if (streak >= 2 && d.at - since >= d.confirmMs) exitBoth('BIAS_REVERSED');
  }
  return ev;
}

/** A session-end exit may use a quote observed in the session's final minutes, and no earlier one. */
export const SESSION_END_QUOTE_WINDOW_MS = 10 * 60_000;

/**
 * Pure: the session ended (intraday) at `closeAt`. Official at the last LTP (as production's session-end close);
 * simulated at the bid of a valid quote from the final 10 minutes, else UNRESOLVED (never an invented fill).
 */
export function onSessionEnd(p: ArmPosition, closeAt: number): string[] {
  const ev: string[] = [];
  const now = closeAt;
  const ltp = p.lastQuote?.ltp ?? null;
  if (p.official.status === 'OPEN') {
    if (ltp != null && ltp > 0) {
      closeOfficial(p, now, ltp, 'SESSION_ENDED');
      ev.push('OFFICIAL_SESSION_ENDED');
    } else {
      p.official = { status: 'CLOSED', exitAt: now, exitPrice: null, reason: 'SESSION_ENDED_NO_PRICE', netR: null };
      ev.push('OFFICIAL_NO_PRICE');
    }
  }
  if (p.sim.status === 'OPEN') setPending(p, now, 'SESSION_ENDED');
  if (p.sim.status === 'EXIT_PENDING') {
    // The session is over: only a quote observed in its final minutes may fill, judged at its own receipt time. The
    // last two-sided quote is tried too: a later book-less tick (most of them) must not hide it (SIM-1.1).
    for (const q of [p.lastQuote, p.lastBookQuote]) {
      if (p.sim.status === 'EXIT_PENDING' && q && q.receivedAt >= closeAt - SESSION_END_QUOTE_WINDOW_MS && q.receivedAt <= closeAt) tryFillPending(p, q, q.receivedAt);
    }
    if (p.sim.status === 'EXIT_PENDING') {
      p.sim.status = 'UNRESOLVED';
      p.sim.reason = `UNRESOLVED_AT_SESSION_END:${p.sim.pendingReason}`;
      ev.push('SIM_UNRESOLVED');
    } else ev.push('SIM_EXIT_FILLED');
  }
  return ev;
}

export const isLive = (p: ArmPosition) => p.official.status === 'OPEN' || p.sim.status === 'OPEN' || p.sim.status === 'EXIT_PENDING';

/** Pure: the arm's entry decision for one candidate. */
export function armEntryDecision(arm: ArmDef, c: ExpCandidate, openOnSlot: boolean, losses: readonly ArmLoss[], now: number, day: string, invalidated: readonly InvalidatedSetup[] = []): { take: boolean; code: string | null } {
  if (c.mode !== 'INTRADAY') return { take: false, code: 'NOT_IN_SCOPE_POSITIONAL' };
  if (openOnSlot) return { take: false, code: 'ARM_SLOT_HELD' };
  if (arm.blockInvalidatedSetup && invalidated.some((b) => !b.reclaimed && b.day === day && sameSetup(b, c))) return { take: false, code: 'INVALIDATED_SETUP' };
  const cool = armCooldownCode(losses, c, now, day);
  if (cool) return { take: false, code: cool };
  const rule = arm.entryRule(c);
  if (rule) return { take: false, code: rule };
  return { take: true, code: null };
}

/** Pure: the loss an arm registers when its OFFICIAL ledger stops out (the baseline registers the same). */
// ---------------- V2 1.1: the invalidated setup and its re-arming ----------------
// The Old Indicator has no setup lifecycle of its own: its candidate id is one per symbol + direction + day, shared by
// every re-entry. The setup's identity is therefore the structural level it leans on (location-quality's nearest level
// behind price): kind + price for fixed levels (OI wall, pivot, previous-day and opening-range levels, the day's
// extremes, where a new extreme is a new level). VWAP drifts every bar, so it is matched by kind alone.
/** Level kinds whose price moves bar by bar while remaining the same level. */
export const MOVING_LEVEL_KINDS: readonly string[] = ['VWAP'];

export interface InvalidatedSetup {
  arm: ArmId;
  day: string;
  at: number;
  exchange: string;
  symbol: string;
  mode: string;
  direction: string;
  level: number;
  kind: string | null;
  /** A closed 15m bar after the invalidation closed back on the trade side of the level: the setup may re-arm. */
  reclaimed: boolean;
}

/** Pure: the setup an invalidation exit retired (the arm must block it), else null. */
export function invalidatedSetupOf(p: ArmPosition, day: string): InvalidatedSetup | null {
  const arm = armFor(p.arm, p.armVersion);
  if (!arm?.blockInvalidatedSetup || p.official.status !== 'CLOSED' || p.official.reason !== 'STRUCTURE_INVALIDATED' || p.candidate.behindLevel == null) return null;
  return { arm: p.arm, day, at: p.official.exitAt!, exchange: p.candidate.exchange, symbol: p.candidate.symbol, mode: p.candidate.mode, direction: p.candidate.direction, level: p.candidate.behindLevel, kind: p.candidate.behindKind ?? null, reclaimed: false };
}

/** Pure: the candidate leans on the same level, the same way, as the invalidated setup. */
export function sameSetup(b: InvalidatedSetup, c: Pick<ExpCandidate, 'exchange' | 'symbol' | 'mode' | 'direction' | 'behindLevel' | 'behindKind'>): boolean {
  if (b.exchange !== c.exchange || b.symbol !== c.symbol || b.mode !== c.mode || b.direction !== c.direction || c.behindLevel == null) return false;
  const kind = c.behindKind ?? null;
  if (b.kind != null && kind != null && b.kind !== kind) return false;
  if (b.kind != null && MOVING_LEVEL_KINDS.includes(b.kind) && kind === b.kind) return true;
  return Math.abs(c.behindLevel - b.level) <= 1e-6 * Math.max(1, Math.abs(b.level));
}

/** Pure: a closed bar after the invalidation that closes back on the trade side of the level re-arms the setup. */
export function reclaimsSetup(b: InvalidatedSetup, bar: { close: number; closeAt: number }): boolean {
  if (bar.closeAt <= b.at) return false;
  return b.direction === 'BULLISH' ? bar.close > b.level : bar.close < b.level;
}

export function lossOf(p: ArmPosition, day: string): ArmLoss | null {
  if (p.official.status !== 'CLOSED' || p.official.reason !== 'STOP_LOSS') return null;
  return { at: p.official.exitAt!, day, exchange: p.candidate.exchange, symbol: p.candidate.symbol, mode: p.candidate.mode, direction: p.candidate.direction, positionId: p.id };
}
