import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { ENTRY_ARMS, ENTRY_CONFIRMATION_VERSION, entryConfirmationEnabled, type EntryArm } from './entry-confirmation-rules.js';
import type { ArmPosition } from './experiment-arms.js';
import type { DiagnosticsQuery } from './signal-diagnostics.js';

export interface EntryObservation { arm: string; arm_version: string; candidate_id: string; decision: string; code: string | null; detail: any }
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const versionOf = (arm: string) => `${arm}-ENTRY-1.0`;

function ledgerStats(ps: ArmPosition[], ledger: 'official' | 'sim') {
  const closed = ps.filter((p) => p[ledger].status === 'CLOSED' && finite(p[ledger].netR));
  const ordered = [...closed].sort((a, b) => a[ledger].exitAt! - b[ledger].exitAt! || a.id.localeCompare(b.id));
  let equity = 0, peak = 0, drawdown = 0;
  for (const p of ordered) { equity += p[ledger].netR!; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  return {
    closed: closed.length,
    open: ps.filter((p) => p[ledger].status === 'OPEN' || p[ledger].status === 'EXIT_PENDING').length,
    unavailable: ps.length - closed.length - ps.filter((p) => p[ledger].status === 'OPEN' || p[ledger].status === 'EXIT_PENDING').length,
    avgNetR: mean(closed.map((p) => p[ledger].netR!)),
    totalNetR: closed.length ? equity : null,
    winRate: closed.length ? closed.filter((p) => p[ledger].netR! > 0).length / closed.length : null,
    realisedDrawdownR: closed.length ? drawdown : null,
  };
}

/** Results remain descriptive: no threshold here can promote an arm or declare a profitable edge. */
export function summarizeEntryConfirmation(positions: ArmPosition[], observations: EntryObservation[]) {
  const ps = positions.filter((p) => (ENTRY_ARMS as readonly string[]).includes(p.arm) && p.armVersion === versionOf(p.arm));
  const obs = [...new Map(observations.filter((o) => o.decision === 'OBSERVE' && o.arm_version === versionOf(o.arm))
    .map((o) => [`${o.arm}|${o.candidate_id}`, o])).values()];
  const arms = ENTRY_ARMS.map((arm) => {
    const own = ps.filter((p) => p.arm === arm);
    const decisions = obs.filter((o) => o.arm === arm);
    const latency = own.flatMap((p) => p.candidate.decisionTime == null ? [] : [(p.openedAt - p.candidate.decisionTime - 900_000) / 1000]).filter((x) => finite(x) && x >= 0);
    return {
      arm, version: versionOf(arm), observed: decisions.length,
      passed: decisions.filter((o) => o.code === 'RULE_PASS').length,
      filtered: decisions.filter((o) => ['OB_REJECTION_NOT_CONFIRMED', 'OF_FLOW_GROUP_MISSING'].includes(o.code ?? '')).length,
      evidenceUnavailable: decisions.filter((o) => o.code === 'ENTRY_EVIDENCE_UNAVAILABLE').length,
      positions: own.length, official: ledgerStats(own, 'official'), simulated: ledgerStats(own, 'sim'),
      // Decision latency, not an invented later-bar confirmation price. Both arms use the same build/quote.
      avgEntryDelaySeconds: mean(latency), entryDelaySamples: latency.length,
      avgEstimatedCostR: mean(own.flatMap((p) => {
        const r = p.candidate.entry - p.initialStop;
        const cost = p.candidate.entry * p.candidate.costPct / 100 / r;
        return r > 0 && finite(cost) ? [cost] : [];
      })),
    };
  });
  const pairs = ([['OB1C', 'OB1J'], ['OF1C', 'OF1G']] as const).map(([control, variant]) => {
    const rejected = obs.filter((o) => o.arm === variant && ['OB_REJECTION_NOT_CONFIRMED', 'OF_FLOW_GROUP_MISSING'].includes(o.code ?? ''));
    const ids = new Set(rejected.map((o) => o.candidate_id));
    const controlPs = ps.filter((p) => p.arm === control && ids.has(p.candidate.candidateId));
    const closed = controlPs.filter((p) => p.official.status === 'CLOSED' && finite(p.official.netR));
    const simClosed = controlPs.filter((p) => p.sim.status === 'CLOSED' && finite(p.sim.netR));
    return {
      control, variant, filteredCandidates: rejected.length,
      controlPositions: controlPs.length,
      noControlPosition: rejected.length - new Set(controlPs.map((p) => p.candidate.candidateId)).size,
      closedControl: closed.length, pendingControl: controlPs.length - closed.length,
      missedWinners: closed.filter((p) => p.official.netR! > 0).length,
      avoidedLosers: closed.filter((p) => p.official.netR! < 0).length,
      flat: closed.filter((p) => p.official.netR === 0).length,
      rejectedControlAvgNetR: mean(closed.map((p) => p.official.netR!)),
      simulatedClosedControl: simClosed.length,
      simulatedMissedWinners: simClosed.filter((p) => p.sim.netR! > 0).length,
      simulatedAvoidedLosers: simClosed.filter((p) => p.sim.netR! < 0).length,
      simulatedRejectedAvgNetR: mean(simClosed.map((p) => p.sim.netR!)),
    };
  });
  const combinations = new Map<string, { evidence: string; observed: number; passed: number; controlClosed: number; sumR: number }>();
  const controlByCandidate = new Map(ps.filter((p) => p.arm === 'OF1C').map((p) => [p.candidate.candidateId, p]));
  for (const o of obs.filter((x) => x.arm === 'OF1G')) {
    const found = o.detail?.entryEvidence?.found;
    const key = Array.isArray(found) ? [...new Set<string>(found)].sort().join(' + ') : 'UNAVAILABLE';
    const row = combinations.get(key) ?? { evidence: key, observed: 0, passed: 0, controlClosed: 0, sumR: 0 };
    row.observed++; if (o.code === 'RULE_PASS') row.passed++;
    const p = controlByCandidate.get(o.candidate_id);
    if (p?.official.status === 'CLOSED' && finite(p.official.netR)) { row.controlClosed++; row.sumR += p.official.netR; }
    combinations.set(key, row);
  }
  return { arms, pairs, combinations: [...combinations.values()].map(({ sumR, ...r }) => ({ ...r, controlAvgNetR: r.controlClosed ? sumR / r.controlClosed : null })) };
}

export async function entryConfirmationReport(q: DiagnosticsQuery) {
  const base = { version: ENTRY_CONFIRMATION_VERSION, enabled: entryConfirmationEnabled() && (process.env.EXPERIMENT_ARMS ?? 'on').toLowerCase() !== 'off' && (process.env.EXPERIMENT_NEW_ENTRIES ?? 'on').toLowerCase() !== 'off',
    note: 'Exploratory same-bar filters; production entries unchanged. Official results include estimated costs; simulated results require executable quotes and fees. Drawdown is realised closed-trade R, not mark-to-market. Entry delay is time after the decision candle closes, not a later-bar entry experiment. Unobserved/missing outcomes are not losses. No automatic promotion.' };
  if (!schemaFileReady('045_experiments_and_linkage.sql')) return { ...base, status: 'UNAVAILABLE' as const, reason: 'EXPERIMENT_SCHEMA_UNAVAILABLE' };
  try {
    const [rows, decisions, activations] = await Promise.all([
      sql<{ state: ArmPosition }[]>`SELECT state FROM experiment_positions WHERE arm IN ('OB1C','OB1J','OF1C','OF1G') AND arm_version = arm || '-ENTRY-1.0'
        AND (${q.since}::timestamptz IS NULL OR opened_at >= ${q.since}) AND (${q.until}::timestamptz IS NULL OR opened_at < ${q.until}) AND (${q.instrument}::text IS NULL OR symbol = ${q.instrument})`,
      sql<EntryObservation[]>`SELECT arm, arm_version, candidate_id, decision, code, detail FROM experiment_decisions WHERE arm IN ('OB1C','OB1J','OF1C','OF1G') AND arm_version = arm || '-ENTRY-1.0' AND decision = 'OBSERVE'
        AND (${q.since}::timestamptz IS NULL OR at >= ${q.since}) AND (${q.until}::timestamptz IS NULL OR at < ${q.until}) AND (${q.instrument}::text IS NULL OR symbol = ${q.instrument}) ORDER BY at, id`,
      sql<{ arm: EntryArm; activated_at: string }[]>`SELECT arm, activated_at FROM experiment_arms WHERE arm IN ('OB1C','OB1J','OF1C','OF1G') AND version = arm || '-ENTRY-1.0' ORDER BY arm`,
    ]);
    return { ...base, status: 'AVAILABLE' as const, activations, ...summarizeEntryConfirmation(rows.map((r) => r.state), decisions) };
  } catch (err: any) {
    logger.warn({ error: err?.message }, 'Entry confirmation report unavailable');
    return { ...base, status: 'UNAVAILABLE' as const, reason: 'EXPERIMENT_QUERY_FAILED' };
  }
}
