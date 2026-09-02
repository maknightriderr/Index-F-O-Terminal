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

// --- Order blocks ---

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
export function detectOrderBlocks(highs: number[], lows: number[], closes: number[]): OrderBlock[] {
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
export function testActiveOrderBlock(blocks: OrderBlock[], currentPrice: number): OrderBlockTest | null {
  const active = blocks.filter((b) => !b.mitigated);
  if (active.length === 0) return null;

  const latest = active[active.length - 1];
  if (currentPrice > latest.top || currentPrice < latest.bottom) return null;

  const span = latest.top - latest.bottom;
  if (span <= 0) return null;
  const raw = latest.type === 'BULLISH' ? (latest.top - currentPrice) / span : (currentPrice - latest.bottom) / span;
  return { block: latest, penetrationPct: Math.max(0, Math.min(1, raw)) };
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
