/** Describe the existing server trail; never change a stop, target or position size. */
export function trailingNote(entry: number, initialStop: number, target: number, state: { state: string; breakevenAtR: number; breakevenPremium: number; lockAtR: number; lockPremium: number }): string {
  if (state.state === 'LOCKED_PROFIT') return `SL locked +1x initial risk (₹${state.lockPremium.toFixed(2)})`;
  const risk = entry - initialStop;
  const lockTrigger = entry + state.lockAtR * risk;
  const beTrigger = entry + state.breakevenAtR * risk;
  if (state.state === 'BREAKEVEN') return target <= lockTrigger
    ? 'SL at entry before costs. Target is reached before the next trailing step.'
    : `SL at entry before costs — at premium ₹${lockTrigger.toFixed(2)}, SL locks to ₹${state.lockPremium.toFixed(2)}`;
  return target <= beTrigger
    ? 'Target is reached before the breakeven trailing step.'
    : `At premium ₹${beTrigger.toFixed(2)}, SL moves to entry ₹${state.breakevenPremium.toFixed(2)} (before costs)`;
}
