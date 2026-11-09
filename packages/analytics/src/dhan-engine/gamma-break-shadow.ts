import type { FreshBar } from '../fresh-start/strategies.js';
import type { Side } from './common.js';

const MINUTE = 60_000;
export interface GammaBreakWatch {
  side: Side;
  level: number;
  at: number;
  until: number;
}

/** Shadow hypothesis: freeze the last three contiguous, already available five-minute bars. */
export function startGammaBreakWatch(side: Side, bars: readonly FreshBar[], at: number, entryUntil: number): GammaBreakWatch | null {
  const step = 5 * MINUTE;
  const last = bars.filter(b => b.time + step <= at && b.availableAt <= at).slice(-3);
  if (last.length !== 3 || at - (last[2].time + step) >= step
    || last.some((b, i) => i > 0 && b.time - last[i - 1].time !== step)) return null;
  const level = side === 'BULLISH' ? Math.max(...last.map(b => b.high)) : Math.min(...last.map(b => b.low));
  const until = Math.min(at + 15 * MINUTE, entryUntil);
  return level > 0 && Number.isFinite(level) && until > at ? { side, level, at, until } : null;
}

/** Causal shadow comparison on the same frozen level. It never constructs a trade. */
export function gammaBreakObservation(watch: GammaBreakWatch, bars: readonly FreshBar[], now: number) {
  const end = Math.min(now, watch.until);
  const visible = bars.filter(b => b.time + MINUTE <= end && b.availableAt <= end);
  const beyond = (b: FreshBar) => watch.side === 'BULLISH' ? b.close > watch.level : b.close < watch.level;
  let first: number | null = null, hold: number | null = null, failedHold: number | null = null;
  for (let i = 1; i < visible.length; i++) {
    const previous = visible[i - 1], bar = visible[i];
    const at = Math.max(bar.time + MINUTE, bar.availableAt, previous.availableAt);
    if (bar.time + MINUTE <= watch.at || bar.time - previous.time !== MINUTE) continue;
    if (!beyond(previous) && beyond(bar)) {
      first = at;
      const next = visible[i + 1];
      if (next && next.time - bar.time === MINUTE) {
        const holdAt = Math.max(next.time + MINUTE, next.availableAt, at);
        if (beyond(next)) hold = holdAt;
        else failedHold = holdAt;
      }
      break;
    }
  }
  return { first, hold, failedHold, expired: now >= watch.until };
}
