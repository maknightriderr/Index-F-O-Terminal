// ============================================================
// STRUCTURE ENGINE — candle labels: no look-ahead, and the score bonus never
// changes an engine decision
// ============================================================
// Reuses the fabricated bearish sweep→displacement→FVG scenario from
// structure-engine.test.ts: PDH swept at 10:45, displacement at 11:00,
// confirmed (FVG) at 11:15.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateStructureSession,
  prepareMomentumSeries,
  scoreStructureSetup,
  STRUCTURE_VARIANTS,
  CLEAN_REJECTION_PATTERNS,
  CANDLE_BONUS_REJECTION,
  CANDLE_BONUS_ENGULFING,
  CANDLE_BONUS_STAR,
  STRUCTURE_TIER1_MAX,
  type MomentumBar,
  type StructureSetup,
} from '@fno/analytics';

const V10 = STRUCTURE_VARIANTS.find((v) => v.id === 'D1.0-GUARD')!;
const BAR = 15 * 60 * 1000;
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);

function bar(time: number, open: number, close: number, wick = 0.2, volume = 1000): MomentumBar {
  return { time, open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume };
}
function session(date: string, closes: number[], startOpen: number): MomentumBar[] {
  let prev = startOpen;
  return closes.map((c, k) => {
    const b = bar(at(date, '09:15') + k * BAR, prev, c);
    prev = c;
    return b;
  });
}
const alternating = (n: number, a = 100, b = 100.5) => Array.from({ length: n }, (_, k) => (k % 2 === 0 ? a : b));
const HIST = ['2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16'];
const PREV = '2026-01-19';
const TODAY = '2026-01-20';
const PREV_CLOSES = [100, 99.5, 99, 98.5, 98, 97.5, 97.2, 97.5, 98, 98.5, 99, 99.5, 100, 100.5, 101, 101.5, 101.8, 101.5, 101.2, 101.0, 101.2, 101.0, 101.2, 101.0, 101.2];

function base(): MomentumBar[] {
  const bars: MomentumBar[] = [];
  let last = 100.5;
  for (const d of HIST) {
    bars.push(...session(d, alternating(25), last));
    last = bars[bars.length - 1].close;
  }
  bars.push(...session(PREV, PREV_CLOSES, last));
  last = bars[bars.length - 1].close;
  bars.push(...session(TODAY, [101.3, 101.0, 101.3, 101.0, 101.3, 101.0], last));
  return bars;
}
const t = (k: number) => at(TODAY, '10:45') + k * BAR;
const B = (k: number, open: number, high: number, low: number, close: number, volume = 1000): MomentumBar => ({ time: t(k), open, high, low, close, volume });

// A clean 1-bar hammer-shaped sweep of PDH (bearish setup — a shooting-star
// shape: small body, long upper wick, negligible lower wick) followed by the
// canonical displacement and confirmation from structure-engine.test.ts.
const SWEEP_STAR = B(0, 101.0, 102.4, 100.975, 100.98); // body 0.02, upper wick 1.4, lower wick 0.005 (well under 0.5x body)
const DISP = B(1, 101.6, 101.7, 100.1, 100.2);
const CONF = B(2, 100.2, 100.6, 99.9, 100.3);

const run = (bars: MomentumBar[], i = bars.length - 1, variant = V10) => evaluateStructureSession(prepareMomentumSeries(bars), i, variant);
const only = (setups: StructureSetup[], dir: 'BEARISH' | 'BULLISH') => setups.filter((s) => s.direction === dir);

describe('candle labels: no look-ahead', () => {
  it('the sweep candle is labelled from DEVELOPING on, unaffected by every bar appended after it', () => {
    const developing = only(run([...base(), SWEEP_STAR]).setups, 'BEARISH')[0];
    expect(developing.patterns?.sweepPattern).toBe('SHOOTING_STAR');
    const full = only(run([...base(), SWEEP_STAR, DISP, CONF]).setups, 'BEARISH')[0];
    // Same sweep candle, same shape, no matter what happened afterwards.
    expect(full.patterns?.sweepPattern).toBe('SHOOTING_STAR');
  });

  it('the displacement label appears only once the displacement bar exists, and is stable afterwards', () => {
    const beforeDisplacement = only(run([...base(), SWEEP_STAR]).setups, 'BEARISH')[0];
    expect(beforeDisplacement.patterns?.displacementPattern).toBeNull();
    const atDisplacement = only(run([...base(), SWEEP_STAR, DISP]).setups, 'BEARISH')[0];
    const withMoreBars = only(run([...base(), SWEEP_STAR, DISP, CONF]).setups, 'BEARISH')[0];
    expect(atDisplacement.patterns?.displacementPattern).toBe(withMoreBars.patterns?.displacementPattern);
    expect(withMoreBars.patterns?.label).toContain('→');
  });

  it('appending arbitrary future bars never changes the patterns recorded at confirmation', () => {
    const full = [...base(), SWEEP_STAR, DISP, CONF];
    const i = full.length - 1;
    const before = only(run(full, i).setups, 'BEARISH')[0].patterns;
    const futures = [
      [B(10, 100, 110, 90, 105), B(11, 105, 106, 80, 81)],
      Array.from({ length: 20 }, (_, k) => B(10 + k, 100, 100 + k, 100 - k, 100)),
    ];
    for (const extra of futures) {
      const after = only(run([...full, ...extra], i).setups, 'BEARISH')[0].patterns;
      expect(after).toEqual(before);
    }
  });
});

describe('the candle-pattern score bonus never changes an engine decision', () => {
  it('a clean rejection sweep gets +4, capped so Tier 1 never exceeds its max', () => {
    const setup = only(run([...base(), SWEEP_STAR, DISP, CONF]).setups, 'BEARISH')[0];
    expect(CLEAN_REJECTION_PATTERNS).toContain(setup.patterns?.sweepPattern);
    expect(setup.score!.candle.rejection).toBe(CANDLE_BONUS_REJECTION);
    expect(setup.score!.tier1.sum).toBeLessThanOrEqual(STRUCTURE_TIER1_MAX);
    expect(setup.score!.tier1.candle).toBe(setup.score!.candle.applied);
  });

  it('baseTotal (used for every ordering) is identical with and without the candle bonus', () => {
    // Deliberately NOT maxed out on tier 1 (bodyAtr = dispMult, no structure
    // shift) — otherwise the candle bonus has no room to show a difference,
    // as it correctly would not (Tier 1 is capped at its max either way).
    const withPatterns = { pool: { kind: 'PREV_DAY_HIGH', side: 'HIGH', price: 1, rank: 1 }, sweep: { index: 0, barTime: 0, bars: 1, extreme: 2, depthAtr: 5 }, displacement: { index: 1, barTime: 0, bodyAtr: 1, closeLocation: 0, structureShift: false, volMult: 2 }, zone: { kind: 'FVG', near: 1, far: 2 }, patterns: { sweepPattern: 'HAMMER', displacementPattern: 'BULLISH_ENGULFING', combo: 'MORNING_STAR', label: 'x' } } as const;
    const withoutPatterns = { ...withPatterns, patterns: null };
    const a = scoreStructureSetup(withPatterns as any, 1);
    const b = scoreStructureSetup(withoutPatterns as any, 1);
    expect(a.total).toBeGreaterThan(b.total); // the bonus visibly raises `total`...
    expect(a.baseTotal).toBe(b.baseTotal); // ...but never `baseTotal`, the only field any ordering reads
    expect(a.candle.applied).toBe(Math.min(CANDLE_BONUS_REJECTION + CANDLE_BONUS_ENGULFING + CANDLE_BONUS_STAR, STRUCTURE_TIER1_MAX - b.tier1.sum));
  });

  it('structureSequenceRefusal never reads score at all, and every mint-path ordering sorts on the score WITHOUT the candle bonus', () => {
    const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const liveSrc = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/structure-live.ts'), 'utf-8');
    const refusalFn = liveSrc.slice(liveSrc.indexOf('export function structureSequenceRefusal'), liveSrc.indexOf('export function structureSequenceDiagnostic'));
    expect(refusalFn).not.toMatch(/\.score\b/);
    expect(refusalFn).not.toMatch(/\.candle\b/);
    // fillCandidate: highest score first — but scoreBase (WITHOUT the bonus), not score.
    expect(liveSrc).toMatch(/orderScore = \(l: LiveLifecycle\) => \(l\.scoreBase/);
    expect(liveSrc).toMatch(/candidates\.sort\(\(a, b\) => orderScore\(b\) - orderScore\(a\)\)/);
    // The backtest's same-bar tie-break: baseTotal, not total.
    const backtestSrc = readFileSync(path.join(REPO_ROOT, 'apps/server/src/backtest/structure-backtest.ts'), 'utf-8');
    expect(backtestSrc).toMatch(/b\.score\?\.baseTotal.*a\.score\?\.baseTotal|sort\(\(a, b\) => \(b\.score\?\.baseTotal/);
  });
});
