// ============================================================
// ICT MARKET STRUCTURE
// ============================================================
// Inner Circle Trader / "smart money concepts" — four well-defined
// geometric ideas from that methodology, built on the SAME swing-point
// detector patterns/index.ts and vcp/index.ts already use, not a second
// drifting copy of that fractal logic:
//
// - Break of Structure (BOS) / Change of Character (CHoCH): classifying
//   the swing sequence as higher-highs/higher-lows (bullish) or
//   lower-highs/lower-lows (bearish), and flagging the moment that
//   sequence continues (BOS) vs. the moment it first breaks the OTHER
//   way (CHoCH — the classic early reversal warning).
// - Liquidity sweep: a candle that wicks through a prior swing high/low
//   (running the stops resting there) but closes back on the other
//   side — a rejection, often read as a trap rather than a genuine
//   break.
// - Order blocks: the last opposing candle before a strong impulsive
//   move away from it — the zone "smart money" is presumed to have
//   built a position in, which often acts as support/resistance on a
//   later retest.
// - Premium/discount: which half of the current trading range price
//   sits in — ICT's own framing for "expensive" vs "cheap" right now,
//   used as context for the other three, not a standalone directional
//   call on its own.
//
// Session "killzones" (London/NY open) are deliberately NOT implemented
// here — that concept is specific to forex session overlaps and doesn't
// translate meaningfully to NSE/MCX trading hours.
// ============================================================

import { findSwingPoints, type SwingPoint } from '../patterns/index.js';
import { atr } from '../indicators/index.js';

// --- Break of Structure / Change of Character ---

export type StructureBias = 'BULLISH' | 'BEARISH' | 'UNCLEAR';
export type StructureEventType = 'BOS' | 'CHOCH';

export interface StructureEvent {
  type: StructureEventType;
  /** Direction of the break itself — BOS continues the existing bias, CHoCH is the first break the OTHER way. */
  direction: 'BULLISH' | 'BEARISH';
  atIndex: number;
}

export interface MarketStructureAnalysis {
  bias: StructureBias;
  lastEvent: StructureEvent | null;
}

/**
 * Classifies the swing sequence as bullish (higher highs + higher lows),
 * bearish (lower highs + lower lows), or unclear, and finds the single
 * most recent structural event: a BOS (the sequence extending in its
 * established direction) or a CHoCH (the first swing to break the
 * OPPOSITE way — ICT's classic early reversal warning, analogous to
 * what RSI divergence catches from a momentum angle instead of price
 * structure).
 */
export function analyzeMarketStructure(highs: number[], lows: number[]): MarketStructureAnalysis {
  const { peaks, troughs } = findSwingPoints(highs, lows, 2);
  if (peaks.length < 2 || troughs.length < 2) return { bias: 'UNCLEAR', lastEvent: null };

  const swings = [
    ...peaks.map((p) => ({ ...p, kind: 'peak' as const })),
    ...troughs.map((t) => ({ ...t, kind: 'trough' as const })),
  ].sort((a, b) => a.index - b.index);

  // Walk the merged swing sequence, comparing each swing against the
  // PRIOR swing of the same kind (peak-vs-peak, trough-vs-trough) to
  // classify it HH/HL/LH/LL, and track the running structural bias.
  let bias: StructureBias = 'UNCLEAR';
  let lastEvent: StructureEvent | null = null;
  let lastPeak: SwingPoint | null = null;
  let lastTrough: SwingPoint | null = null;

  for (const swing of swings) {
    if (swing.kind === 'peak') {
      if (lastPeak) {
        const higherHigh = swing.price > lastPeak.price;
        if (higherHigh) {
          lastEvent = bias === 'BEARISH' ? { type: 'CHOCH', direction: 'BULLISH', atIndex: swing.index } : { type: 'BOS', direction: 'BULLISH', atIndex: swing.index };
          bias = 'BULLISH';
        } else {
          lastEvent = bias === 'BULLISH' ? { type: 'CHOCH', direction: 'BEARISH', atIndex: swing.index } : { type: 'BOS', direction: 'BEARISH', atIndex: swing.index };
          bias = 'BEARISH';
        }
      }
      lastPeak = swing;
    } else {
      if (lastTrough) {
        const higherLow = swing.price > lastTrough.price;
        if (higherLow) {
          lastEvent = bias === 'BEARISH' ? { type: 'CHOCH', direction: 'BULLISH', atIndex: swing.index } : { type: 'BOS', direction: 'BULLISH', atIndex: swing.index };
          bias = 'BULLISH';
        } else {
          lastEvent = bias === 'BULLISH' ? { type: 'CHOCH', direction: 'BEARISH', atIndex: swing.index } : { type: 'BOS', direction: 'BEARISH', atIndex: swing.index };
          bias = 'BEARISH';
        }
      }
      lastTrough = swing;
    }
  }

  return { bias, lastEvent };
}

// --- Liquidity sweeps ---

export type LiquiditySweepType = 'BUY_SIDE' | 'SELL_SIDE';

export interface LiquiditySweep {
  /** BUY_SIDE = swept a prior high (the stops/liquidity resting above it); SELL_SIDE = swept a prior low. */
  type: LiquiditySweepType;
  sweptLevel: number;
  atIndex: number;
}

// The wick must clear the prior level by at least this much (as a % of
// the level) to count as a genuine run, not float-noise sitting exactly
// on it; the close must reject back inside by at least this much too.
const SWEEP_MIN_PIERCE_PCT = 0.0005;

/**
 * Most recent candle only: did it wick through the immediately prior
 * swing high/low and then close back on the other side? That combination
 * — briefly trading through a level heavy with resting stop orders, then
 * rejecting — is what ICT calls a liquidity sweep (a stop-hunt), read as
 * a trap rather than a genuine breakout.
 */
export function detectLiquiditySweep(highs: number[], lows: number[], closes: number[]): LiquiditySweep | null {
  const n = closes.length;
  if (n < 6) return null;
  const { peaks, troughs } = findSwingPoints(highs.slice(0, -1), lows.slice(0, -1), 2);

  const curHigh = highs[n - 1];
  const curLow = lows[n - 1];
  const curClose = closes[n - 1];

  const priorPeak = peaks[peaks.length - 1];
  if (priorPeak && curHigh > priorPeak.price * (1 + SWEEP_MIN_PIERCE_PCT) && curClose < priorPeak.price * (1 - SWEEP_MIN_PIERCE_PCT)) {
    return { type: 'BUY_SIDE', sweptLevel: priorPeak.price, atIndex: n - 1 };
  }

  const priorTrough = troughs[troughs.length - 1];
  if (priorTrough && curLow < priorTrough.price * (1 - SWEEP_MIN_PIERCE_PCT) && curClose > priorTrough.price * (1 + SWEEP_MIN_PIERCE_PCT)) {
    return { type: 'SELL_SIDE', sweptLevel: priorTrough.price, atIndex: n - 1 };
  }

  return null;
}

// --- Order blocks: LEGACY (OB-1.0, frozen) ---
//
// KNOWN BROKEN. Kept byte-identical ONLY because the indicator engine's live
// structure vote still reads it while ORDER_BLOCK_MODE=SHADOW, so the paper
// trades cannot change. Measured 2026-10-08 on 11,146 replayed polls over 76
// symbols, it never fired: (1) the current candle is part of the series, so a
// block price sits inside is always marked mitigated by that same candle;
// (2) 2% over three 15m closes never happens on the indices; (3) a candle's
// direction is read from the previous close, not its open. Use OB-2.0 below.

export type OrderBlockType = 'BULLISH' | 'BEARISH';

export interface OrderBlock {
  type: OrderBlockType;
  top: number;
  bottom: number;
  atIndex: number;
  mitigated: boolean;
}

// The impulse leaving the block must be at least this large (close-to-
// close) to count as a real "smart money" move, not ordinary noise —
// same order of magnitude as patterns/index.ts's own flag-pole threshold.
const ORDER_BLOCK_IMPULSE_MIN_PCT = 0.02;

/**
 * The last down-close candle before a strong up-move away from it is a
 * bullish order block (the zone often acts as support on a later
 * retest); mirror for bearish. Scans the whole series and returns every
 * block found, oldest first, each flagged with whether a later candle
 * has already traded back into it ("mitigated").
 */
export function detectOrderBlocksLegacy(highs: number[], lows: number[], closes: number[]): OrderBlock[] {
  const n = closes.length;
  const candidates: OrderBlock[] = [];

  for (let i = 1; i < n - 1; i++) {
    const bodyClose = closes[i];
    const bodyOpenApprox = closes[i - 1]; // no separate open series available here — prior close approximates this candle's open closely enough for a body-direction read
    const isDownCandle = bodyClose < bodyOpenApprox;
    const isUpCandle = bodyClose > bodyOpenApprox;

    // Impulse measured over the next couple of candles' worth of closes
    // away from this one.
    const lookAhead = Math.min(3, n - 1 - i);
    if (lookAhead < 1) continue;
    const impulseEnd = closes[i + lookAhead];
    const impulsePct = bodyClose !== 0 ? (impulseEnd - bodyClose) / Math.abs(bodyClose) : 0;

    if (isDownCandle && impulsePct >= ORDER_BLOCK_IMPULSE_MIN_PCT) {
      candidates.push({ type: 'BULLISH', top: highs[i], bottom: lows[i], atIndex: i, mitigated: false });
    } else if (isUpCandle && impulsePct <= -ORDER_BLOCK_IMPULSE_MIN_PCT) {
      candidates.push({ type: 'BEARISH', top: highs[i], bottom: lows[i], atIndex: i, mitigated: false });
    }
  }

  // A multi-bar decline leading into one big impulse satisfies the check
  // above at EVERY bar along the way (each one's own "3 candles ahead"
  // window eventually reaches the same impulse) — keep only the LAST
  // candidate in each consecutive run, since ICT's order block is
  // specifically the last opposing candle immediately before the move,
  // not every candle that happened to precede it.
  const blocks = candidates.filter((c, idx) => {
    const next = candidates[idx + 1];
    return !(next && next.atIndex === c.atIndex + 1 && next.type === c.type);
  });

  for (const block of blocks) {
    for (let j = block.atIndex + 1; j < n; j++) {
      if (highs[j] >= block.bottom && lows[j] <= block.top) {
        block.mitigated = true;
        break;
      }
    }
  }

  return blocks;
}

export interface OrderBlockTest {
  block: OrderBlock;
  penetrationPct: number;
}

/** Same "most recent unmitigated zone only" logic as fvg/index.ts's testActiveFvg. */
export function testActiveOrderBlockLegacy(blocks: OrderBlock[], currentPrice: number): OrderBlockTest | null {
  const active = blocks.filter((b) => !b.mitigated);
  if (active.length === 0) return null;

  const latest = active[active.length - 1];
  if (currentPrice > latest.top || currentPrice < latest.bottom) return null;

  const span = latest.top - latest.bottom;
  if (span <= 0) return null;
  const raw = latest.type === 'BULLISH' ? (latest.top - currentPrice) / span : (currentPrice - latest.bottom) / span;
  return { block: latest, penetrationPct: Math.max(0, Math.min(1, raw)) };
}

// --- Order blocks: OB-2.0 (2026-10-09) ---
//
// The last opposing candle before a displacement that leaves it, on CLOSED
// candles only, with its lifecycle FRESH -> FIRST_TOUCH -> MITIGATED. Fixed,
// documented rule (ORDER_BLOCK_RULES), deterministic and replayable: every
// value as of bar k reads bars <= k only, so appending later bars never
// changes what was known at k. (The reaction fields are measurement: filled
// in from bars after the first touch and never read by a decision.)
//
// Bullish (bearish mirrors):
//   block candle i      a down candle: close < open (the REAL open)
//   displacement bar j  within displacementWithinBars after i, every bar
//                       between i and j not a down candle (i is the LAST
//                       opposing candle), and j an up candle whose body is
//                       >= displacementBodyAtr x ATR(14) as of bar i, closing
//                       in the outer displacementCloseFrac of its own range,
//                       and closing above the high of bar i (it leaves the block)
//   the block           [low_i, high_i]; it exists from bar j + 1, so the
//                       candles that formed it can never touch or mitigate it
//   FIRST_TOUCH         the first later bar whose low reaches the block top
//   MITIGATED           the first bar from the first touch on that closes
//                       below the block bottom (the block failed)
// The decision signal (orderBlockSignalAt): at a closed decision bar, the
// newest block first touched ON that bar and not mitigated by its close.

export const ORDER_BLOCK_VERSION = 'OB-2.0';

export const ORDER_BLOCK_RULES = Object.freeze({
  atrPeriod: 14,
  /** The displacement bar must close within this many bars after the block candle. */
  displacementWithinBars: 3,
  /** Displacement body (|close - open|) in ATR(14) as of the block candle. */
  displacementBodyAtr: 1.0,
  /** The displacement bar closes in this outer fraction of its own range. */
  displacementCloseFrac: 0.3,
  /** Reaction (measurement only): bars after the first touch over which MFE / MAE are measured. */
  reactionBars: 8,
});

export type OrderBlockState = 'FRESH' | 'FIRST_TOUCH' | 'MITIGATED';

export interface OhlcBar {
  time?: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface OrderBlockV2 {
  type: OrderBlockType;
  /** Index of the block (opposing) candle. */
  blockIndex: number;
  /** Index of the displacement bar; the block exists from the bar after it. */
  displacementIndex: number;
  top: number;
  bottom: number;
  /** ATR(14) as of the block candle. */
  atr: number;
  /** The displacement bar's body, in ATR. */
  displacementAtr: number;
  state: OrderBlockState;
  firstTouchIndex: number | null;
  mitigatedIndex: number | null;
  /**
   * Measurement only: from the first touch's close over the next
   * reactionBars bars available, the best move in the block's direction and
   * the worst against it, in ATR; held = it gave >= 1 ATR before failing.
   * Null before the first touch.
   */
  reaction: { barsMeasured: number; mfeAtr: number; maeAtr: number; held: boolean | null } | null;
}

/** ATR(period) as of each bar (Wilder), null before it is defined. Bar k reads bars <= k. */
export function atrAsOf(bars: readonly OhlcBar[], period: number = ORDER_BLOCK_RULES.atrPeriod): Array<number | null> {
  const series = atr(bars.map((b) => b.high), bars.map((b) => b.low), bars.map((b) => b.close), period);
  return bars.map((_, k) => (k >= period && series[k - period] != null ? series[k - period] : null));
}

/**
 * Every OB-2.0 block known at the close of bar `uptoIndex` (default: the
 * last bar), oldest first, with its lifecycle as of that bar. Pass CLOSED
 * bars only.
 */
export function detectOrderBlocks(bars: readonly OhlcBar[], uptoIndex: number = bars.length - 1): OrderBlockV2[] {
  const R = ORDER_BLOCK_RULES;
  const upto = Math.min(uptoIndex, bars.length - 1);
  const atrs = atrAsOf(bars.slice(0, upto + 1));
  const blocks: OrderBlockV2[] = [];
  for (let i = 0; i < upto; i++) {
    const b = bars[i];
    const a = atrs[i];
    if (a == null || !(a > 0)) continue;
    // A down candle is a bullish block, an up candle a bearish one.
    const dir: 1 | -1 | 0 = b.close < b.open ? 1 : b.close > b.open ? -1 : 0;
    if (dir === 0) continue;
    for (let j = i + 1; j <= Math.min(upto, i + R.displacementWithinBars); j++) {
      const d = bars[j];
      const up = d.close > d.open;
      const down = d.close < d.open;
      // A later opposing candle before the displacement: i is not the last one.
      if ((dir === 1 && down) || (dir === -1 && up)) break;
      const body = Math.abs(d.close - d.open);
      const range = d.high - d.low;
      const closesOuter = range > 0 && (dir === 1 ? d.high - d.close <= R.displacementCloseFrac * range : d.close - d.low <= R.displacementCloseFrac * range);
      const leaves = dir === 1 ? d.close > b.high : d.close < b.low;
      if (((dir === 1 && up) || (dir === -1 && down)) && body >= R.displacementBodyAtr * a && closesOuter && leaves) {
        blocks.push(lifecycle({ type: dir === 1 ? 'BULLISH' : 'BEARISH', blockIndex: i, displacementIndex: j, top: b.high, bottom: b.low, atr: a, displacementAtr: Math.round((body / a) * 1000) / 1000 }, bars, upto));
        break;
      }
    }
  }
  return blocks;
}

function lifecycle(
  base: Pick<OrderBlockV2, 'type' | 'blockIndex' | 'displacementIndex' | 'top' | 'bottom' | 'atr' | 'displacementAtr'>,
  bars: readonly OhlcBar[],
  upto: number
): OrderBlockV2 {
  const bull = base.type === 'BULLISH';
  let firstTouchIndex: number | null = null;
  let mitigatedIndex: number | null = null;
  for (let k = base.displacementIndex + 1; k <= upto; k++) {
    const b = bars[k];
    if (firstTouchIndex == null && (bull ? b.low <= base.top : b.high >= base.bottom)) firstTouchIndex = k;
    if (firstTouchIndex != null && (bull ? b.close < base.bottom : b.close > base.top)) {
      mitigatedIndex = k;
      break;
    }
  }
  const state: OrderBlockState = mitigatedIndex != null ? 'MITIGATED' : firstTouchIndex != null ? 'FIRST_TOUCH' : 'FRESH';
  let reaction: OrderBlockV2['reaction'] = null;
  if (firstTouchIndex != null) {
    const ref = bars[firstTouchIndex].close;
    const after = bars.slice(firstTouchIndex + 1, Math.min(upto, firstTouchIndex + ORDER_BLOCK_RULES.reactionBars) + 1);
    const best = after.length ? (bull ? Math.max(...after.map((x) => x.high)) - ref : ref - Math.min(...after.map((x) => x.low))) : 0;
    const worst = after.length ? (bull ? ref - Math.min(...after.map((x) => x.low)) : Math.max(...after.map((x) => x.high)) - ref) : 0;
    const inAtr = (v: number) => Math.round((Math.max(0, v) / base.atr) * 1000) / 1000;
    const mitigatedInWindow = mitigatedIndex != null && mitigatedIndex <= firstTouchIndex + ORDER_BLOCK_RULES.reactionBars;
    reaction = {
      barsMeasured: after.length,
      mfeAtr: inAtr(best),
      maeAtr: inAtr(worst),
      held: best >= base.atr ? true : mitigatedInWindow || after.length >= ORDER_BLOCK_RULES.reactionBars ? false : null,
    };
  }
  return { ...base, state, firstTouchIndex, mitigatedIndex, reaction };
}

export interface OrderBlockSignal {
  block: OrderBlockV2;
  /** +1 bullish, -1 bearish. */
  vote: 1 | -1;
}

/**
 * The OB-2.0 decision signal at closed bar `i`: the newest block that was
 * FRESH before bar i, is first touched ON bar i, and is not mitigated by
 * bar i's close. Reads bars <= i only.
 */
export function orderBlockSignalAt(bars: readonly OhlcBar[], i: number): OrderBlockSignal | null {
  const touched = detectOrderBlocks(bars, i).filter((b) => b.firstTouchIndex === i && b.mitigatedIndex == null);
  if (touched.length === 0) return null;
  const latest = touched.reduce((a, b) => (b.displacementIndex > a.displacementIndex ? b : a));
  return { block: latest, vote: latest.type === 'BULLISH' ? 1 : -1 };
}

// --- Premium / discount ---

export type PremiumDiscountZone = 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';

export interface PremiumDiscountReading {
  rangeHigh: number;
  rangeLow: number;
  zone: PremiumDiscountZone;
}

// Within this fraction of the range's midpoint counts as equilibrium
// rather than a clean premium/discount read.
const EQUILIBRIUM_BAND_PCT = 0.05;

/**
 * Where does the current price sit within its recent trading range —
 * ICT's "premium" (upper half, expensive, look to sell/short) vs
 * "discount" (lower half, cheap, look to buy/long) framing. Context for
 * the other three concepts above, not a standalone directional call.
 */
export function classifyPremiumDiscount(highs: number[], lows: number[], currentPrice: number, lookback = 20): PremiumDiscountReading {
  const window = Math.min(lookback, highs.length, lows.length);
  const recentHighs = highs.slice(-window);
  const recentLows = lows.slice(-window);
  const rangeHigh = Math.max(...recentHighs);
  const rangeLow = Math.min(...recentLows);
  const mid = (rangeHigh + rangeLow) / 2;
  const range = rangeHigh - rangeLow;
  const band = range * EQUILIBRIUM_BAND_PCT;

  const zone: PremiumDiscountZone = currentPrice > mid + band ? 'PREMIUM' : currentPrice < mid - band ? 'DISCOUNT' : 'EQUILIBRIUM';
  return { rangeHigh, rangeLow, zone };
}
