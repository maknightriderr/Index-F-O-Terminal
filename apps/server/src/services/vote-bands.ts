// ============================================================
// VOTE HOLD BANDS (hysteresis)
// ============================================================
// Moved verbatim out of market-bias.ts so the pure intraday-positioning
// module can band its votes with exactly the same rule. Pure, no I/O.
// ============================================================

export type Vote = -1 | 0 | 1;

/**
 * A threshold vote with hysteresis. Entering +1 needs `value > enterUp`;
 * once +1 (per `prev`), it holds while `value > holdUp` (holdUp sits inside
 * enterUp). Mirror for -1. Without the hold band a reading hovering at a
 * threshold flipped the vote every poll — and with only a handful of votes
 * per source, one flip was enough to flip the whole direction.
 */
export function bandVote(value: number, prev: Vote | undefined, enterUp: number, holdUp: number, enterDown: number, holdDown: number): Vote {
  if (!Number.isFinite(value)) return 0;
  if (prev === 1 && value > holdUp) return 1;
  if (prev === -1 && value < holdDown) return -1;
  if (value > enterUp) return 1;
  if (value < enterDown) return -1;
  return 0;
}
