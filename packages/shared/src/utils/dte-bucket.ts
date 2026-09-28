// ============================================================
// DTE TIERS — one definition, used everywhere a days-to-expiry band is read
// ============================================================
// Before this, three places each carried their own informal DTE tiers:
//
//   greeks/index.ts        analyzeTimeDecay: <=1 EXTREME, <=3 FAST, <=7 MODERATE, else SLOW
//   market-scanner.ts      DTE credit:       <=1 none,    <=3 partial,  else full
//   option-quality/index.ts summary note:    <=1 "expiry day"
//
// Same edges (1 / 3 / 7), written three times. They now all call
// classifyDteTier() below, so the edges cannot drift apart. That refactor
// changes no behaviour: every caller maps the tier back to exactly the value
// it produced before.
//
// classifyDteBucket() is the REPORTING label (Phase 2): the five buckets
// 0DTE / 1-3DTE / 4-7DTE / 8-30DTE / 30+DTE. It is a label on an
// already-computed dte and gates nothing — no rule reads it.
//
// Note the two are deliberately not the same partition. The engine's tiers
// treat 0 and 1 DTE together as "expiry window" (a 1-DTE option carries
// expiry-day gamma too), while the reporting buckets separate 0DTE so a
// report can see same-day expiry on its own. Both come from the same edge
// constants.
// ============================================================

/** Upper edges (inclusive, calendar days) of the DTE bands. Labels only — not thresholds any rule gates on. */
export const DTE_EDGES = {
  /** Same-day expiry. */
  sameDay: 0,
  /** Expiry window the engine treats as expiry-day (0 or 1 DTE). */
  expiryWindow: 1,
  /** Short-dated: through 3 DTE. */
  short: 3,
  /** Within a week: through 7 DTE. */
  week: 7,
  /** Within a month: through 30 DTE. */
  month: 30,
} as const;

/** The engine's existing four-tier read, previously written out separately in three files. */
export type DteTier = 'EXPIRY_WINDOW' | 'SHORT' | 'WEEK' | 'LONGER';

export function classifyDteTier(dte: number): DteTier {
  if (dte <= DTE_EDGES.expiryWindow) return 'EXPIRY_WINDOW';
  if (dte <= DTE_EDGES.short) return 'SHORT';
  if (dte <= DTE_EDGES.week) return 'WEEK';
  return 'LONGER';
}

/** Reporting buckets. */
export type DteBucket = '0DTE' | '1-3DTE' | '4-7DTE' | '8-30DTE' | '30+DTE';

export const DTE_BUCKETS: readonly DteBucket[] = ['0DTE', '1-3DTE', '4-7DTE', '8-30DTE', '30+DTE'] as const;

/**
 * The five-bucket reporting label for a days-to-expiry value. Null when dte is
 * unknown. Fractional DTE is floored to whole calendar days first.
 */
export function classifyDteBucket(dte: number | null | undefined): DteBucket | null {
  if (dte == null || !Number.isFinite(dte)) return null;
  const d = Math.max(0, Math.floor(dte));
  if (d <= DTE_EDGES.sameDay) return '0DTE';
  if (d <= DTE_EDGES.short) return '1-3DTE';
  if (d <= DTE_EDGES.week) return '4-7DTE';
  if (d <= DTE_EDGES.month) return '8-30DTE';
  return '30+DTE';
}
