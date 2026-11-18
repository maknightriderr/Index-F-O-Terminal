// ============================================================
// PAPER TRADE RESULT — one plain-language result and reason for every paper trade (owner, 18 Nov)
// ============================================================
// PROFIT / LOSS / EXPIRED (closed without the stop or the target) / OPEN, from the recorded outcome, close reason and
// net R; and why it ended, in words. Used by the trade tables, the fresh-start trade list and the symbol page.
// ============================================================

export type PaperResult = 'OPEN' | 'PROFIT' | 'LOSS' | 'FLAT' | 'EXPIRED';

const REASONS: Record<string, string> = {
  TARGET: 'Target hit',
  UNDERLYING_TARGET: 'Target hit (underlying)',
  STOP_LOSS: 'Stop loss hit',
  STOP_TRADED: 'Stop loss hit',
  EMERGENCY_STOP: 'Emergency premium stop hit',
  TRAILING_STOP: 'Trailing stop hit after the trade moved in profit',
  BREAKEVEN_STOP: 'Stopped at breakeven (stop had been moved to entry)',
  SESSION_ENDED: 'Session ended before stop or target — closed at the session close',
  SESSION_ENDED_NO_PRICE: 'Session ended — no closing price was available',
  SESSION_CUTOFF: 'Session cut-off before stop or target — closed at market',
  MAX_HOLD: 'Maximum holding time reached — closed at market',
  NO_PROGRESS: 'No progress within the allowed time — closed at market',
  TIME_EXIT: 'Time exit reached — closed at market',
  STRUCTURAL_INVALIDATION: 'Setup invalidated: the chart structure broke',
  SWEEP_RECLAIMED: 'Setup invalidated: the swept level was reclaimed',
  LEVEL_RECLAIMED: 'Setup invalidated: the level was reclaimed',
  SETUP_INVALIDATED: 'Setup invalidated',
  BIAS_REVERSED: 'Market bias reversed — closed at market',
  TRIGGER_REVERSAL: 'The entry trigger reversed — closed at market',
  FLOW_UNAVAILABLE: 'Order-flow data stopped — closed at market',
};

/** The close reason in words; an unknown code is shown as words rather than hidden. */
export function paperReasonText(code: string | null | undefined): string | null {
  if (!code) return null;
  return REASONS[code] ?? code.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * The result: OPEN while held; EXPIRED when it closed without its stop or target (time, session end, invalidation);
 * otherwise PROFIT / LOSS / FLAT by net R (net P&L when R is unknown).
 */
export function paperResult(x: { open: boolean; state?: string | null; closeReason?: string | null; netR?: number | null; netPnl?: number | null }): PaperResult {
  if (x.open) return 'OPEN';
  if (x.state === 'EXPIRED') return 'EXPIRED';
  const v = x.netR ?? x.netPnl ?? null;
  if (v == null) return x.state === 'WIN' ? 'PROFIT' : x.state === 'LOSS' ? 'LOSS' : 'EXPIRED';
  return v > 0 ? 'PROFIT' : v < 0 ? 'LOSS' : 'FLAT';
}

/** "16 Nov 2026" in IST. */
export function istDateLabel(ts: number): string {
  return new Date(ts).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
}
