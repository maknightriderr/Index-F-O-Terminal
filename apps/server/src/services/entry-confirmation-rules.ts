/** Exploratory, same-decision-bar filters. Never consulted by production entry rules. */
export const ENTRY_CONFIRMATION_VERSION = 'ENTRY-CONFIRM-1.0';
export const ENTRY_ARMS = ['OB1C', 'OB1J', 'OF1C', 'OF1G'] as const;
export type EntryArm = typeof ENTRY_ARMS[number];
export const isEntryArm = (id: string): id is EntryArm => (ENTRY_ARMS as readonly string[]).includes(id);
/** Drain switch: disables only NEW entries/observations; existing positions keep their exits. */
export const entryConfirmationEnabled = () => (process.env.ENTRY_CONFIRMATION_EXPERIMENTS ?? 'on').toLowerCase() !== 'off';

export type EntryEvidence = {
  version: typeof ENTRY_CONFIRMATION_VERSION;
  direction: 'BULLISH' | 'BEARISH';
  decisionTime: number; // closed 15m bar's OPEN time
} & ({
  source: 'OB1'; sourceVersion: 'OB-2.0';
  blockTop: number; blockBottom: number; close: number;
} | {
  source: 'OF1'; sourceVersion: 'OF1-1.2';
  found: string[]; alignment: 'ALIGNED'; flowBasis: 'INFERRED';
});

export function entryRuleCode(arm: EntryArm, e?: EntryEvidence): string | null {
  if (!e || e.version !== ENTRY_CONFIRMATION_VERSION || !Number.isFinite(e.decisionTime) || e.decisionTime <= 0 || !['BULLISH', 'BEARISH'].includes(e.direction)) return 'ENTRY_EVIDENCE_UNAVAILABLE';
  if (arm.startsWith('OB1')) {
    if (e.source !== 'OB1' || e.sourceVersion !== 'OB-2.0' || ![e.blockTop, e.blockBottom, e.close].every((p) => Number.isFinite(p) && p > 0) || e.blockTop <= e.blockBottom) return 'ENTRY_EVIDENCE_UNAVAILABLE';
    if (arm === 'OB1C') return null;
    // Strict > / <: a close on the edge is not a rejection-confirmed entry.
    return (e.direction === 'BULLISH' ? e.close > e.blockTop : e.close < e.blockBottom) ? null : 'OB_REJECTION_NOT_CONFIRMED';
  }
  if (e.source !== 'OF1' || e.sourceVersion !== 'OF1-1.2' || e.alignment !== 'ALIGNED' || e.flowBasis !== 'INFERRED' || !Array.isArray(e.found)) return 'ENTRY_EVIDENCE_UNAVAILABLE';
  const allowed = ['DELTA', 'IMBALANCE', 'ABSORPTION', 'ACCEPTANCE', e.direction === 'BULLISH' ? 'POC_UP' : 'POC_DOWN'];
  if (e.found.some((s) => !allowed.includes(s)) || new Set(e.found).size < 2) return 'ENTRY_EVIDENCE_UNAVAILABLE';
  if (arm === 'OF1C') return null;
  const pressure = e.found.some((s) => s === 'DELTA' || s === 'IMBALANCE');
  const response = e.found.some((s) => s === 'ABSORPTION' || s === 'ACCEPTANCE' || s === 'POC_UP' || s === 'POC_DOWN');
  // These groups diversify evidence; they are NOT statistically independent or exchange-exact.
  return pressure && response ? null : 'OF_FLOW_GROUP_MISSING';
}

/** The option build must still refer to the observed source, direction and closed decision bar. */
export function entryCandidateRule(arm: EntryArm, c: { entryEvidence?: EntryEvidence; direction: string; triggerId?: string; decisionTime?: number; at: number }): string | null {
  const e = c.entryEvidence;
  if (!e || c.direction !== e.direction || c.triggerId !== e.source || c.decisionTime !== e.decisionTime || !Number.isFinite(c.at) || c.at < e.decisionTime + 900_000) return 'ENTRY_EVIDENCE_UNAVAILABLE';
  return entryRuleCode(arm, e);
}
