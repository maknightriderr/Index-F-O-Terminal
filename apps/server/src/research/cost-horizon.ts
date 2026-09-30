// ============================================================
// COST SENSITIVITY (item 5) and HORIZON SENSITIVITY (item 6, pre-registered)
// ============================================================
import type { LoadedSymbol } from '../backtest/harness.js';
import { gradePath } from '../services/grade-path.js';
import { round, mean } from './stats.js';

export const COST_LEVELS = [0, 0.05, 0.1, 0.15] as const;

export function costSensitivity(grossRs: number[]) {
  return COST_LEVELS.map((cost) => {
    const netRs = grossRs.map((g) => g - cost);
    const n = netRs.length;
    const wins = netRs.filter((r) => r > 0).length;
    return { cost, trades: n, avgNetR: n ? round(mean(netRs)) : null, winRate: n ? round(wins / n, 3) : null, lowN: n < 30 };
  });
}

/** Re-grades a trade with an unreachable target in its favour direction, so the only exits are STOP or SESSION_END (the session close) — tests whether letting winners run to the close (instead of a fixed R target) changes the outcome. Same stop, same entry, same start bar. */
export function gradeToSessionClose(loaded: LoadedSymbol, startIdx: number, dir: 1 | -1, entry: number, stop: number): number | null {
  const { series } = loaded;
  const s = series.sessionIdx[startIdx];
  const sessionEnd = (s + 1 < series.sessionStarts.length ? series.sessionStarts[s + 1] : series.bars.length) - 1;
  const after = series.bars.slice(startIdx + 1, sessionEnd + 1);
  if (after.length === 0) return null;
  const unreachableTarget = dir > 0 ? entry + 1e9 : entry - 1e9;
  const path = gradePath(after, dir, entry, stop, unreachableTarget);
  return round(path.settledR);
}
