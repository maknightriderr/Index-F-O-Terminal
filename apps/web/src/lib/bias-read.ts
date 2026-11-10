// Audit F-23 (11 Nov): a direction with low confidence, or one against the 1-hour regime, read as a firm call
// (CRUDEOIL: BULLISH 29 in a STRONG_BEAR_TREND). The engine is unchanged; this only words what is shown.
export const BIAS_WEAK_BELOW = 40;
export function biasCaveat(direction: string, confidence: number, regime: string): string | null {
  const notes: string[] = [];
  if (direction !== 'NEUTRAL' && confidence < BIAS_WEAK_BELOW) notes.push(`Weak read (${Math.round(confidence)} / 100): treat as neutral, leaning ${direction.toLowerCase()}`);
  const against = (direction === 'BULLISH' && /BEAR/.test(regime)) || (direction === 'BEARISH' && /BULL/.test(regime));
  if (against) notes.push(`Against the 1-hour trend (${regime.replace(/_/g, ' ').toLowerCase()}): counter-trend`);
  return notes.length ? notes.join('. ') + '.' : null;
}
