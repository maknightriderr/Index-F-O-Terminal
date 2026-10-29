// Read-only reporting. No trading decision imports this module.
import type { StrategyValidationReport, StrategyValidationRow } from '@fno/shared';
import { MEASUREMENT_RELIABLE_FROM, eligibilityOf, type MeasuredTrade } from './measurement-core.js';

export interface ValidationInput {
  trade: MeasuredTrade;
  logicVersion: string | null;
  sourceVersion: string | null;
}
const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** Keep versions, modes, exchanges and reliability populations separate. Never guess missing costs or sources. */
export function summarizeStrategyValidation(inputs: ValidationInput[], inventory: string[], complete: boolean, rowLimit: number, now: number): StrategyValidationReport {
  const groups = new Map<string, { row: StrategyValidationRow; days: Set<string> }>();
  for (const { trade: t, logicVersion, sourceVersion } of inputs) {
    const strategy = t.family === 'UNKNOWN' ? 'UNATTRIBUTED' : t.family;
    const population = t.mintedAt >= MEASUREMENT_RELIABLE_FROM ? 'RELIABLE' : 'HISTORICAL';
    const key = JSON.stringify([strategy, logicVersion, sourceVersion, t.mode, t.exchange, population]);
    let g = groups.get(key);
    if (!g) {
      g = { days: new Set(), row: { key, strategy, logicVersion: logicVersion ?? 'UNRECORDED', sourceVersion: sourceVersion ?? 'UNRECORDED', mode: t.mode, exchange: t.exchange, population,
        total: 0, open: 0, excluded: 0, missingCost: 0, measured: 0, profitable: 0, losing: 0, flat: 0, expired: 0, sessions: 0,
        grossR: null, costR: null, profitR: null, lossR: null, netR: null, expectancyR: null, profitFactor: null, noLosses: false, status: 'NO_MEASURABLE_RESULTS' } };
      groups.set(key, g);
    }
    const r = g.row;
    r.total++;
    const eligible = eligibilityOf(t);
    if (eligible === 'OPEN') { r.open++; continue; }
    if (eligible !== 'ELIGIBLE' || !['WIN', 'LOSS', 'EXPIRED'].includes(t.outcome ?? '') ||
      ![t.entry, t.initialStop, t.exitPrice].every(v => typeof v === 'number' && Number.isFinite(v)) || !(t.entry! > t.initialStop!)) {
      r.excluded++; continue;
    }
    if (t.estimatedCostPct == null || !Number.isFinite(t.estimatedCostPct) || t.estimatedCostPct < 0) { r.missingCost++; continue; }
    const risk = t.entry! - t.initialStop!;
    const gross = (t.exitPrice! - t.entry!) / risk;
    const cost = t.entry! * t.estimatedCostPct / 100 / risk;
    const net = gross - cost;
    if (![gross, cost, net].every(Number.isFinite)) { r.excluded++; continue; }
    r.measured++;
    if (net > 1e-9) r.profitable++; else if (net < -1e-9) r.losing++; else r.flat++;
    if (t.outcome === 'EXPIRED') r.expired++;
    r.grossR = (r.grossR ?? 0) + gross;
    r.costR = (r.costR ?? 0) + cost;
    r.netR = (r.netR ?? 0) + net;
    r.profitR = (r.profitR ?? 0) + Math.max(0, net);
    r.lossR = (r.lossR ?? 0) + Math.max(0, -net);
    g.days.add(new Date(t.mintedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  }
  const rows = [...groups.values()].map(({ row: r, days }) => {
    r.sessions = days.size;
    r.noLosses = r.measured > 0 && r.lossR === 0 && r.profitR! > 0;
    r.profitFactor = r.lossR != null && r.lossR > 0 ? round(r.profitR! / r.lossR) : null;
    r.expectancyR = r.measured ? round(r.netR! / r.measured) : null;
    r.status = !r.measured ? 'NO_MEASURABLE_RESULTS' : r.measured < 30 || r.sessions < 20 ? 'SMALL_SAMPLE' :
      r.netR! < -1e-9 ? 'NEGATIVE_REVIEW' : r.netR! > 1e-9 ? 'POSITIVE_UNPROVEN' : 'FLAT';
    for (const k of ['grossR', 'costR', 'profitR', 'lossR', 'netR'] as const) if (r[k] != null) r[k] = round(r[k]!);
    return r;
  }).sort((a, b) => a.strategy.localeCompare(b.strategy) || a.key.localeCompare(b.key));
  return { asOf: new Date(now).toISOString(), complete, rowLimit, loaded: inputs.length, reliableFrom: new Date(MEASUREMENT_RELIABLE_FROM).toISOString(), inventory: [...new Set([...inventory, ...rows.map(r => r.strategy)])].sort(), rows };
}
