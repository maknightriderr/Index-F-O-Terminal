// ============================================================
// VOLATILITY CONTRACTION PATTERN (VCP)
// ============================================================
// Mark Minervini's base-building setup: a sequence of pullbacks off
// swing highs, each one progressively SHALLOWER than the last (price
// "coiling" tighter as sellers dry up), ideally on shrinking volume too
// — followed by a breakout above the base's resistance on expanding
// volume. Reuses patterns/index.ts's own swing-point detector rather
// than a second, possibly-drifting copy of the same fractal logic.
//
// This is a multi-week/multi-month base-building pattern in its classic
// (Minervini) form, meaningfully identifiable on daily bars — not an
// intraday shape. The caller decides which candle tier to feed it (see
// market-bias.ts, which runs this on the "long" tier: Daily in
// POSITIONAL mode, 1H in INTRADAY, same tier chartStructureLong uses).
//
// Bullish-only by design: VCP has no standard bearish mirror in its
// original methodology (a "reverse VCP" for shorting bases exists in
// some derivative writing, but isn't the well-defined concept this
// module implements) — it always describes a base a stock is building
// before breaking UP out of it.
// ============================================================

import { findSwingPoints } from '../patterns/index.js';

export interface VcpContraction {
  peakIndex: number;
  peakPrice: number;
  troughIndex: number;
  troughPrice: number;
  /** Decline from peak to trough, as a fraction (0.10 = 10%). */
  depthPct: number;
}

export interface DetectedVcp {
  /** Most recent contraction legs, oldest first — the ones actually checked for shrinking depth. */
  contractions: VcpContraction[];
  /** Current close ÷ the base's resistance (the highest peak among the contractions checked). >=1 means price has broken out above it. */
  breakoutRatio: number;
  /** True if the final contraction's average volume was meaningfully lower than the one before it — the "volume dry-up" Minervini looks for. Null when volume data wasn't provided. */
  volumeDryUp: boolean | null;
  confidence: number; // 0-100
  /** Index of the most recent contraction's trough — the point the pattern is currently basing from. */
  atIndex: number;
}

// A pullback shallower than this is noise, not a real contraction leg —
// and one deeper than MAX counts as an actual correction, not a base
// tightening.
const MIN_CONTRACTION_DEPTH_PCT = 0.05;
const MAX_CONTRACTION_DEPTH_PCT = 0.35;
// Each contraction must be no deeper than this fraction of the prior
// one — the defining "getting tighter" trait. 0.85 allows real-world
// noise (a contraction doesn't have to be dramatically tighter every
// single time) while still ruling out a flat or widening sequence.
const CONTRACTION_SHRINK_FACTOR = 0.85;
const MIN_CONTRACTIONS = 2;
// Cap on how many trailing legs count toward the pattern — Minervini's
// own examples rarely go past 3-4 meaningful contractions before either
// breaking out or the base is considered too old/wide to trust.
const MAX_CONTRACTIONS_CHECKED = 4;
const VOLUME_DRY_UP_FACTOR = 0.85; // final leg's avg volume must be below this fraction of the prior leg's to count as a dry-up

export function detectVcp(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes?: number[]
): DetectedVcp | null {
  const { peaks, troughs } = findSwingPoints(highs, lows, 2);
  if (peaks.length < MIN_CONTRACTIONS || troughs.length < MIN_CONTRACTIONS) return null;

  // Walk peaks and troughs together in chronological order so a
  // peak-then-trough pair can be read off as one contraction leg,
  // instead of treating the two swing lists independently.
  const swings = [
    ...peaks.map((p) => ({ ...p, kind: 'peak' as const })),
    ...troughs.map((t) => ({ ...t, kind: 'trough' as const })),
  ].sort((a, b) => a.index - b.index);

  const contractions: VcpContraction[] = [];
  for (let i = 0; i < swings.length - 1; i++) {
    const a = swings[i];
    const b = swings[i + 1];
    if (a.kind !== 'peak' || b.kind !== 'trough' || b.price >= a.price || a.price <= 0) continue;
    const depthPct = (a.price - b.price) / a.price;
    if (depthPct >= MIN_CONTRACTION_DEPTH_PCT && depthPct <= MAX_CONTRACTION_DEPTH_PCT) {
      contractions.push({ peakIndex: a.index, peakPrice: a.price, troughIndex: b.index, troughPrice: b.price, depthPct });
    }
  }

  if (contractions.length < MIN_CONTRACTIONS) return null;

  const recent = contractions.slice(-MAX_CONTRACTIONS_CHECKED);
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].depthPct > recent[i - 1].depthPct * CONTRACTION_SHRINK_FACTOR) return null;
  }

  const patternHigh = Math.max(...recent.map((c) => c.peakPrice));
  const lastClose = closes[closes.length - 1];
  const breakoutRatio = patternHigh > 0 && lastClose != null ? lastClose / patternHigh : 1;

  let volumeDryUp: boolean | null = null;
  if (volumes && volumes.length === closes.length && recent.length >= 2) {
    const avgVolumeOver = (c: VcpContraction) => {
      const slice = volumes.slice(c.peakIndex, c.troughIndex + 1);
      return slice.length > 0 ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
    };
    const priorVol = avgVolumeOver(recent[recent.length - 2]);
    const lastVol = avgVolumeOver(recent[recent.length - 1]);
    volumeDryUp = priorVol > 0 ? lastVol < priorVol * VOLUME_DRY_UP_FACTOR : null;
  }

  // Tighter final contraction relative to the first one scores higher —
  // a base that went from a 20% pullback down to a 6% one is a much
  // cleaner read than one that barely tightened at all.
  const firstDepth = recent[0].depthPct;
  const lastDepth = recent[recent.length - 1].depthPct;
  const tightness = firstDepth > 0 ? Math.max(0, Math.min(1, 1 - lastDepth / firstDepth)) : 0;
  let confidence = Math.round(50 + tightness * 30);
  if (volumeDryUp) confidence = Math.min(92, confidence + 10);

  return {
    contractions: recent,
    breakoutRatio: Math.round(breakoutRatio * 1000) / 1000,
    volumeDryUp,
    confidence,
    atIndex: recent[recent.length - 1].troughIndex,
  };
}
