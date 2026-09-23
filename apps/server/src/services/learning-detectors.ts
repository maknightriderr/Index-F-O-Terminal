// ============================================================
// LEARNING DETECTORS
// ============================================================
// Adapters, not a validation engine.
//
// Every check here already exists and already runs: the population
// reconciliation, the boundary contract, the lineage contract, the Greek
// coverage grade, the null/zero audit, the chain-completeness figures, the
// data-quality events, the boot-time schema result, the protected-constants
// audit. This module does one thing — turn a failure any of them ALREADY
// reports into a durable finding with a stable signature.
//
// Building a second set of checks here would be worse than useless: two
// validators over the same data drift apart, and the day they disagree is
// the day nobody knows which one to believe. So there is no new measurement
// in this file. If a detector needs a number, it reads it from the audit
// that owns it.
//
// Pure: every detector takes already-computed audit output and returns
// findings. No IO, so each one can be exercised against constructed input.
//
// Nothing here is read by the trading engine.
// ============================================================

import {
  buildSignature,
  qualifiesAsSystemError,
  requiresHumanApproval,
  type Severity,
} from './learning-taxonomy.js';

export interface Finding {
  category: string;
  module: string;
  component?: string | null;
  symbol?: string | null;
  expiry?: string | null;
  signature: string;
  title: string;
  description: string;
  expected: string;
  actual: string;
  difference?: string | null;
  severity: Severity;
  /**
   * The contract this breaches. Required: a finding that cannot name one is
   * not a fault, and the taxonomy gate rejects it.
   */
  violatedContract: string;
  /** Established cause, or null. NEVER a guess — null routes to human review. */
  rootCause: string | null;
  rootCauseConfidence?: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  /** The live assertion that re-checks this fault each cycle. */
  assertionKey: string;
  /** What a protection for this fault would assert, when one is possible. */
  proposedProtection?: {
    type: string;
    title: string;
    rule: string;
    implementedIn: string;
  } | null;
  humanApprovalRequired: boolean;
  evidence: Record<string, unknown>;
}

/** What one detector produced, including its own failure to run. */
export interface DetectorResult {
  detector: string;
  findings: Finding[];
  /** Set when the detector itself could not evaluate. Not the same as "clean". */
  error: string | null;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Builds a finding, refusing any that does not clear the system-error gate.
 *
 * Centralised so no detector can bypass it, and so a finding whose signature
 * carries a measured value cannot reach the database.
 */
function makeFinding(f: Omit<Finding, 'signature' | 'humanApprovalRequired'> & {
  fault: string;
  scope?: string | null;
}): Finding | null {
  const verdict = qualifiesAsSystemError({
    violatedContract: f.violatedContract,
    expected: f.expected,
    actual: f.actual,
    hindsightOnly: false,
  });
  if (!verdict.isSystemError) return null;

  return {
    ...f,
    signature: buildSignature({ category: f.category, fault: f.fault, scope: f.scope ?? null }),
    humanApprovalRequired: requiresHumanApproval({ category: f.category, module: f.module }),
  };
}

// ============================================================
// POPULATION RECONCILIATION
// ============================================================

/**
 * The nine identities the population model already evaluates.
 *
 * Each identity gets its own signature so "historical != pre + post" and
 * "Σ per-symbol runs != global" are different faults with separate histories.
 * Collapsing them under one POPULATION_MISMATCH signature would make the
 * occurrence count meaningless — nine unrelated faults sharing one counter.
 */
const IDENTITY_FAULTS: Record<string, { fault: string; rule: string; title: string }> = {
  historical_splits_into_pre_and_post: {
    fault: 'HISTORICAL_PRE_POST_RECONCILIATION',
    rule: 'historical_snapshot_count == pre_lineage_snapshot_count + post_lineage_snapshot_count',
    title: 'Historical snapshot population does not split into pre- and post-lineage',
  },
  post_splits_into_linked_and_orphan: {
    fault: 'POST_LINKED_ORPHAN_RECONCILIATION',
    rule: 'post_lineage_snapshot_count == linked_snapshot_count + orphan_snapshot_count',
    title: 'Post-lineage population does not split into linked and orphan',
  },
  linked_within_post: {
    fault: 'LINKED_EXCEEDS_POST',
    rule: 'linked_snapshot_count <= post_lineage_snapshot_count',
    title: 'More linked snapshots than post-lineage snapshots',
  },
  per_symbol_historical_sums_to_global: {
    fault: 'PER_SYMBOL_HISTORICAL_SUM',
    rule: 'Σ per-symbol historical + unattributed == global historical',
    title: 'Per-symbol historical counts do not sum to the global figure',
  },
  per_symbol_post_sums_to_global: {
    fault: 'PER_SYMBOL_POST_SUM',
    rule: 'Σ per-symbol post == global post',
    title: 'Per-symbol post-lineage counts do not sum to the global figure',
  },
  per_symbol_linked_sums_to_global: {
    fault: 'PER_SYMBOL_LINKED_SUM',
    rule: 'Σ per-symbol linked == global linked',
    title: 'Per-symbol linked counts do not sum to the global figure',
  },
  per_symbol_runs_sum_to_global: {
    fault: 'PER_SYMBOL_RUNS_SUM',
    rule: 'Σ per-symbol successful runs + unattributed == global successful runs',
    title: 'Per-symbol capture-run counts do not sum to the global figure',
  },
  no_post_lineage_null_run_id: {
    fault: 'POST_LINEAGE_NULL_RUN_ID',
    rule: 'post_lineage_null_run_id_count == 0',
    title: 'A snapshot inside the lineage era carries no capture_run_id',
  },
  no_unattributed_rows: {
    fault: 'UNATTRIBUTED_ROWS',
    rule: 'unattributed_snapshot_count == unattributed_run_count == unattributed_symbol_count == unattributed_expiry_count == 0',
    title: 'Rows could not be attributed to a symbol, expiry or run',
  },
};

export function detectPopulationFaults(lineage: Record<string, any> | null): DetectorResult {
  const out: DetectorResult = { detector: 'population_reconciliation', findings: [], error: null };
  const rc = lineage?.populationReconciliation;
  if (rc == null) {
    out.error = 'the lineage section reported no populationReconciliation — the audit could not be evaluated, which is not the same as it passing';
    return out;
  }

  for (const [key, meta] of Object.entries(IDENTITY_FAULTS)) {
    if (rc[key] !== false) continue;

    // The detail string already names both sides of every failed identity.
    const detail: string = String(rc.detail ?? '');
    const mine = detail.split(' | ').find((d) => d.startsWith(key)) ?? detail;

    const isLineage = key === 'no_post_lineage_null_run_id';
    const isAttribution = key === 'no_unattributed_rows';

    const f = makeFinding({
      category: isLineage ? 'DATA_LINEAGE' : isAttribution ? 'MISSING_DATA' : 'POPULATION_MISMATCH',
      module: 'snapshot-populations',
      component: key,
      fault: meta.fault,
      title: meta.title,
      description: mine,
      expected: meta.rule,
      actual: mine,
      severity: isLineage ? 'CRITICAL' : 'HIGH',
      violatedContract: `population reconciliation identity ${key}`,
      // The identity says WHAT is inconsistent, never WHY. Filling this in
      // would be inventing a cause.
      rootCause: null,
      assertionKey: `populationReconciliation.${key}`,
      proposedProtection: {
        type: 'INVARIANT',
        title: meta.title,
        rule: meta.rule,
        implementedIn: 'apps/server/src/services/snapshot-population-model.ts reconcile()',
      },
      evidence: {
        identity: key,
        detail: mine,
        snapshots: lineage?.populations ?? null,
        runs: lineage?.captureRunPopulations ?? null,
      },
    });
    if (f) out.findings.push(f);
  }

  // The offending rows, named individually, as their own per-instrument
  // findings — a chain that is unstamped only for one symbol is a different
  // fault from the capture path failing everywhere.
  const violations: any[] = Array.isArray(lineage?.lineageEraViolations) ? lineage.lineageEraViolations : [];
  for (const v of violations) {
    const f = makeFinding({
      category: 'DATA_LINEAGE',
      module: 'market-state-capture',
      component: 'capture_run_id stamping',
      symbol: v.symbol ?? null,
      expiry: v.expiry ?? null,
      fault: 'UNSTAMPED_SNAPSHOT_IN_LINEAGE_ERA',
      scope: v.exchange && v.symbol ? `${v.exchange}_${v.symbol}` : null,
      title: `Snapshot written without a capture_run_id: ${v.exchange ?? '?'} ${v.symbol ?? '?'}`,
      description: String(v.issue ?? ''),
      expected: 'every snapshot at or after the lineage contract activation carries a capture_run_id',
      actual: `snapshot at ${v.timestamp} carries none`,
      severity: 'CRITICAL',
      violatedContract: 'lineage contract: post-activation snapshots must be stamped',
      rootCause: null,
      assertionKey: 'lineage.post_lineage_null_run_id_count',
      proposedProtection: {
        type: 'VALIDATION_RULE',
        title: 'Post-lineage snapshot must carry an authoritative run id',
        rule: 'POST_LINEAGE snapshot must contain a capture_run_id matching a capture_runs row',
        implementedIn: 'apps/server/src/services/snapshot-population-model.ts classifySnapshot()',
      },
      evidence: { violation: v, era: lineage?.populations?.lineage_era_started_at ?? null },
    });
    if (f) out.findings.push(f);
  }

  return out;
}

// ============================================================
// REPORT BOUNDARY
// ============================================================

export function detectBoundaryFaults(boundary: Record<string, any> | null): DetectorResult {
  const out: DetectorResult = { detector: 'report_boundary', findings: [], error: null };
  if (boundary == null) {
    out.error = 'no boundaryContract in the diagnostics response';
    return out;
  }
  const violations: any[] = Array.isArray(boundary.violations) ? boundary.violations : [];
  for (const v of violations) {
    const f = makeFinding({
      category: 'TIMESTAMP_ERROR',
      module: 'report-boundary',
      component: String(v.section ?? 'unknown'),
      fault: 'SECTION_AS_OF_DIVERGENCE',
      scope: String(v.section ?? ''),
      title: `Diagnostics section "${v.section}" does not share report_as_of`,
      description: String(v.issue ?? ''),
      expected: `section as_of == report_as_of (${boundary.report_as_of})`,
      actual: String(v.as_of ?? 'none stated'),
      severity: 'MEDIUM',
      violatedContract: 'one report_as_of for every bounded diagnostics section',
      rootCause: null,
      assertionKey: 'boundaryContract.as_of_consistent',
      proposedProtection: {
        type: 'ASSERTION',
        title: 'Every query-bounded section states exactly report_as_of',
        rule: 'for each section where kind == query_bound: section.as_of == report_as_of',
        implementedIn: 'apps/server/src/services/report-boundary.ts checkBoundaries()',
      },
      evidence: { violation: v, report_as_of: boundary.report_as_of },
    });
    if (f) out.findings.push(f);
  }
  return out;
}

// ============================================================
// POPULATION CALCULATION CONTRACT
// ============================================================

export function detectPopulationContractFaults(pc: Record<string, any> | null): DetectorResult {
  const out: DetectorResult = { detector: 'population_contract', findings: [], error: null };
  if (pc == null) {
    out.error = 'no populationContract in the diagnostics response';
    return out;
  }
  const count = num(pc.population_calculation_invocation_count);
  if (count != null && count !== 1) {
    const f = makeFinding({
      category: 'REGRESSION',
      module: 'api/backtesting',
      component: 'diagnostics',
      fault: 'MULTIPLE_POPULATION_CALCULATIONS_PER_REPORT',
      title: 'More than one population calculation in a single report',
      description:
        'The report performed more than one population calculation. Two reads of a live table are two instants, so the sections consuming them can no longer be compared.',
      expected: 'exactly 1 population calculation per report',
      actual: String(count),
      difference: String(count - 1),
      severity: 'HIGH',
      violatedContract: '1 as_of -> 1 calculation -> 1 immutable result -> N consumers',
      rootCause: null,
      assertionKey: 'populationContract.population_calculation_invocation_count',
      proposedProtection: {
        type: 'ASSERTION',
        title: 'One population calculation per report',
        rule: 'population_calculation_invocation_count == 1',
        implementedIn: 'apps/server/src/api/backtesting.ts diagnostics handler',
      },
      evidence: { populationContract: pc },
    });
    if (f) out.findings.push(f);
  }
  if (pc.as_of_consistent === false) {
    const f = makeFinding({
      category: 'TIMESTAMP_ERROR',
      module: 'api/backtesting',
      component: 'population as_of',
      fault: 'POPULATION_AS_OF_INCONSISTENT',
      title: 'Population and consumer sections report different as_of values',
      description: 'The population result and the sections consuming it do not agree on the instant they describe.',
      expected: 'report_as_of == population_as_of == lineage_as_of == universe_as_of',
      actual: JSON.stringify(pc.as_of_values ?? {}),
      severity: 'HIGH',
      violatedContract: 'one as_of across the population and all its consumers',
      rootCause: null,
      assertionKey: 'populationContract.as_of_consistent',
      evidence: { as_of_values: pc.as_of_values ?? null },
    });
    if (f) out.findings.push(f);
  }
  return out;
}

// ============================================================
// LINEAGE CONTRACT AUTHORITY
// ============================================================

export function detectLineageContractFaults(lc: Record<string, any> | null): DetectorResult {
  const out: DetectorResult = { detector: 'lineage_contract', findings: [], error: null };
  if (lc == null) {
    out.error = 'no lineageContract in the diagnostics response';
    return out;
  }
  if (lc.authoritative === false) {
    const f = makeFinding({
      category: 'DATA_LINEAGE',
      module: 'lineage-contract',
      component: 'marker authority',
      fault: 'LINEAGE_MARKER_NOT_AUTHORITATIVE',
      title: 'The lineage boundary is not backed by an authoritative marker',
      description:
        'A boundary derived from the rows it governs cannot detect a stamping failure at its own beginning, so it may not carry the post-lineage invariant.',
      expected: 'lineage_era_source in the authoritative set',
      actual: String(lc.lineage_era_source ?? 'null'),
      severity: 'CRITICAL',
      violatedContract: 'the lineage era must come from an authoritative activation marker',
      rootCause: null,
      assertionKey: 'lineageContract.authoritative',
      proposedProtection: {
        type: 'DATA_CONTRACT',
        title: 'Lineage boundary must be authoritative',
        rule: 'AUTHORITATIVE_SOURCES.includes(lineage_era_source)',
        implementedIn: 'apps/server/src/services/lineage-contract.ts lineageEra()',
      },
      evidence: { lineageContract: lc },
    });
    if (f) out.findings.push(f);
  }
  if (lc.runtime_activation_timestamp_unverified === true) {
    const f = makeFinding({
      category: 'DATA_LINEAGE',
      module: 'lineage-contract',
      component: 'runtime activation',
      fault: 'RUNTIME_ACTIVATION_UNVERIFIED',
      title: 'The lineage activation instant has no runtime evidence behind it',
      description:
        'The boundary is a stand-in rather than the verified instant the lineage-aware writer started, so rows near it are classified on an approximation.',
      expected: 'runtime_activation_timestamp_unverified == false',
      actual: 'true',
      severity: 'MEDIUM',
      violatedContract: 'the lineage activation instant is backed by runtime evidence',
      rootCause: 'the deployment runtime log for the activating deploy has not been read',
      rootCauseConfidence: 'HIGH',
      assertionKey: 'lineageContract.runtime_activation_timestamp_unverified',
      evidence: { lineageContract: lc },
    });
    if (f) out.findings.push(f);
  }
  return out;
}

// ============================================================
// GREEK COVERAGE / NULL-ZERO / CHAIN COMPLETENESS
// ============================================================

export function detectDataQualityFaults(input: {
  greeks: Record<string, any> | null;
  nullZero: Record<string, any> | null;
  chains: Record<string, any> | null;
  dataQualityLast24h?: { issue: string; severity: string; n: number }[] | null;
}): DetectorResult {
  const out: DetectorResult = { detector: 'data_quality', findings: [], error: null };

  // Greek coverage: only a FAIL grade is a fault. PARTIAL is the known,
  // already-documented split between contract generations; recording it every
  // day would bury real findings under a standing one.
  const all = Array.isArray(input.greeks?.populations)
    ? input.greeks!.populations.find((p: any) => p.population === 'ALL')
    : null;
  if (all?.grade === 'FAIL') {
    const f = makeFinding({
      category: 'DATA_QUALITY',
      module: 'data-integrity',
      component: 'greek coverage',
      fault: 'GREEK_COVERAGE_FAIL',
      title: 'Greek coverage graded FAIL',
      description: 'The proportion of legs carrying all four Greeks fell below the FAIL threshold.',
      expected: 'grade of PASS or PARTIAL',
      actual: `FAIL (${String(all.nonNullPct ?? '?')}% non-null)`,
      severity: 'HIGH',
      violatedContract: 'Greek coverage grading thresholds',
      rootCause: null,
      assertionKey: 'greeks.populations[ALL].grade',
      evidence: { population: all },
    });
    if (f) out.findings.push(f);
  }

  // Columns the null/zero audit itself flagged as suspicious.
  //
  // The audit returns a SENTENCE per column, not a column name:
  //   "delta: 17692 rows read exactly 0, where a zero is not a valid ..."
  //
  // Only the column belongs in the signature. The row count belongs in
  // `actual`, where it is expected to change between runs. Putting the whole
  // sentence in the scope carried the count into the signature, so the same
  // fault produced a different signature every cycle — caught on the first
  // production run by the stability guard, which refused all seven findings
  // rather than storing a set of records that could never match each other.
  const suspicious: string[] = Array.isArray(input.nullZero?.suspicious) ? input.nullZero!.suspicious : [];
  for (const entry of suspicious) {
    const col = entry.split(':')[0].trim();
    const f = makeFinding({
      category: 'DATA_QUALITY',
      module: 'data-integrity',
      component: col,
      fault: 'SUSPICIOUS_ZERO_DISTRIBUTION',
      scope: col,
      title: `Column "${col}" has a suspicious zero distribution`,
      description:
        'The null/zero audit flagged this column: a zero rate this high on a measured field usually means absence is being stored as zero.',
      expected: 'zeros only where zero is a real measurement',
      actual: entry,
      severity: 'MEDIUM',
      violatedContract: 'NULL_PRESERVING write contract — absence is stored as NULL, never as zero',
      rootCause: null,
      assertionKey: 'nullZero.suspicious',
      proposedProtection: {
        type: 'VALIDATION_RULE',
        title: 'Absence is written as NULL, not zero',
        rule: 'storeIfPositive / storeIfFinite at the capture write boundary',
        implementedIn: 'apps/server/src/services/capture-quality.ts',
      },
      evidence: { column: col, finding: entry, columns: input.nullZero?.columns ?? null },
    });
    if (f) out.findings.push(f);
  }

  // Data-quality events the engine already records during the session.
  for (const row of input.dataQualityLast24h ?? []) {
    if (row.severity !== 'SEVERE') continue;
    const f = makeFinding({
      category: 'DATA_QUALITY',
      module: 'data-quality',
      component: row.issue,
      fault: `RECORDED_${row.issue}`,
      scope: row.issue,
      title: `Severe data-quality issue recorded: ${row.issue}`,
      description: `The live data-quality checker recorded ${row.n} severe ${row.issue} event(s) in the last 24 hours.`,
      expected: '0 severe data-quality events',
      actual: `${row.n} event(s)`,
      severity: 'HIGH',
      violatedContract: `data-quality threshold for ${row.issue}`,
      rootCause: null,
      assertionKey: `dataQuality.${row.issue}`,
      evidence: { issue: row },
    });
    if (f) out.findings.push(f);
  }

  return out;
}

// ============================================================
// SCHEMA / CONFIGURATION
// ============================================================

export function detectSchemaFaults(schema: Record<string, any> | null): DetectorResult {
  const out: DetectorResult = { detector: 'capture_schema', findings: [], error: null };
  if (schema == null) {
    out.error = 'no boot-time schema result available';
    return out;
  }
  const failed = num(schema.failed) ?? 0;
  if (failed > 0) {
    const f = makeFinding({
      category: 'CONFIGURATION',
      module: 'ensure-capture-schema',
      component: 'boot-time migration',
      fault: 'CAPTURE_SCHEMA_STATEMENTS_FAILED',
      title: 'Boot-time capture schema application had failures',
      description:
        'One or more required schema statements failed at boot. Capture writes are fire-and-forget, so a missing column records nothing while the service reports healthy.',
      expected: '0 failed schema statements',
      actual: `${failed} failed`,
      difference: String(failed),
      severity: 'CRITICAL',
      violatedContract: 'the capture schema is fully applied before capture starts',
      rootCause: null,
      assertionKey: 'captureSchemaStatus.failed',
      proposedProtection: {
        type: 'MONITOR',
        title: 'Boot-time schema failures are surfaced, not swallowed',
        rule: 'captureSchemaStatus().failed == 0',
        implementedIn: 'apps/server/src/services/ensure-capture-schema.ts',
      },
      evidence: { schema },
    });
    if (f) out.findings.push(f);
  }
  return out;
}

// ============================================================
// PROTECTED TRADING CONSTANTS
// ============================================================

/**
 * A changed trading constant, detected from the audit that already checks them.
 *
 * This is the one detector whose finding is deliberately the most severe in
 * the system and whose remedy is never automatic: if a protected constant has
 * moved, either the change was intended and the audit list needs a human to
 * update it, or it was not intended and a human needs to know immediately.
 * The engine must do neither on its own.
 */
export function detectProtectedConstantFaults(audit: {
  total: number;
  present: number;
  changed: { needle: string; file: string; label: string }[];
  holds: boolean;
  detail: string;
} | null): DetectorResult {
  const out: DetectorResult = { detector: 'protected_constants', findings: [], error: null };
  if (audit == null) {
    out.error = 'the protected-constants audit could not be run';
    return out;
  }
  for (const c of audit.changed) {
    const f = makeFinding({
      category: 'REGRESSION',
      module: c.file,
      component: c.label,
      fault: 'PROTECTED_TRADING_CONSTANT_CHANGED',
      scope: c.label,
      title: `Protected trading constant changed: ${c.label}`,
      description:
        'A constant on the protected list is no longer byte-identical in the live source. Either the change was deliberate and the audit list must be updated by a person, or it was not — and this engine may do neither.',
      expected: `"${c.needle}" present in ${c.file}`,
      actual: 'not found',
      severity: 'CRITICAL',
      violatedContract: 'the 18 protected trading constants are byte-identical',
      rootCause: null,
      assertionKey: 'protectedConstants.holds',
      evidence: { changed: c, detail: audit.detail, total: audit.total, present: audit.present },
    });
    // Belt and braces: this category is already in the human-approval list,
    // and the flag is set explicitly so a taxonomy edit cannot quietly
    // un-gate a trading-constant change.
    if (f) out.findings.push({ ...f, humanApprovalRequired: true });
  }
  return out;
}

// ============================================================
// RUN / SNAPSHOT RELATIONSHIP
// ============================================================

/**
 * A successful capture run that wrote no snapshot.
 *
 * Note what this does NOT report: a run writing MORE than one snapshot. That
 * is a legitimate capture-contract observation, not a fault, and asserting
 * one-run-one-snapshot is the false invariant the population model
 * deliberately refuses to carry.
 */
export function detectRunSnapshotFaults(rel: Record<string, any> | null): DetectorResult {
  const out: DetectorResult = { detector: 'run_snapshot_relationship', findings: [], error: null };
  if (rel == null) {
    out.error = 'no runToSnapshotRelationship reported';
    return out;
  }
  const none = num(rel.runs_with_no_snapshot) ?? 0;
  if (none > 0) {
    const f = makeFinding({
      category: 'SNAPSHOT_MISMATCH',
      module: 'market-state-capture',
      component: 'run without snapshot',
      fault: 'SUCCESSFUL_RUN_WROTE_NO_SNAPSHOT',
      title: 'A successful capture run wrote no snapshot',
      description:
        'A run inside the lineage era recorded SUCCESS or PARTIAL but no snapshot carries its id, so a capture that reported success produced no data.',
      expected: '0 successful runs with no snapshot',
      actual: `${none} run(s)`,
      difference: String(none),
      severity: 'HIGH',
      violatedContract: 'a successful capture run writes at least one snapshot',
      rootCause: null,
      assertionKey: 'runToSnapshotRelationship.runs_with_no_snapshot',
      proposedProtection: {
        type: 'RECONCILIATION',
        title: 'Every successful run in the era has a snapshot carrying its id',
        rule: 'runs_with_no_snapshot == 0',
        implementedIn: 'apps/server/src/services/snapshot-populations.ts',
      },
      evidence: { relationship: rel },
    });
    if (f) out.findings.push(f);
  }
  return out;
}

// ============================================================
// STALE CAPTURE
// ============================================================

/**
 * Capture having stopped, measured against the report boundary rather than
 * the wall clock, so the staleness figure is commensurable with the rest of
 * the report.
 */
export function detectStalenessFaults(input: {
  reportAsOf: string | null;
  lastSnapshotAt: string | null;
  captureIntervalMinutes: number;
  marketOpen: boolean;
}): DetectorResult {
  const out: DetectorResult = { detector: 'capture_staleness', findings: [], error: null };
  if (input.reportAsOf == null) {
    out.error = 'no report_as_of to measure staleness against';
    return out;
  }
  // Outside market hours a gap is expected, not a fault. Reporting it would
  // fire every single night and train the reader to ignore the category.
  if (!input.marketOpen) return out;
  if (input.lastSnapshotAt == null) {
    const f = makeFinding({
      category: 'DATA_STALENESS',
      module: 'market-state-capture',
      component: 'oi_snapshots',
      fault: 'NO_SNAPSHOT_EVER_WRITTEN',
      title: 'No option-chain snapshot has ever been written',
      description: 'The capture tables hold no snapshot at all while the market is open.',
      expected: 'at least one snapshot',
      actual: 'none',
      severity: 'CRITICAL',
      violatedContract: 'market-state capture writes on its interval during market hours',
      rootCause: null,
      assertionKey: 'capture.lastSnapshotAt',
      evidence: { reportAsOf: input.reportAsOf },
    });
    if (f) out.findings.push(f);
    return out;
  }

  const ageMs = Date.parse(input.reportAsOf) - Date.parse(input.lastSnapshotAt);
  // Three intervals: one missed tick is jitter, three is a stopped writer.
  const allowedMs = input.captureIntervalMinutes * 3 * 60_000;
  if (ageMs > allowedMs) {
    const f = makeFinding({
      category: 'DATA_STALENESS',
      module: 'market-state-capture',
      component: 'oi_snapshots',
      fault: 'CAPTURE_STALE_DURING_MARKET_HOURS',
      title: 'Option-chain capture is stale during market hours',
      description:
        'The newest snapshot is older than three capture intervals while the market is open, which is a stopped writer rather than jitter.',
      expected: `newest snapshot within ${input.captureIntervalMinutes * 3} minutes of report_as_of`,
      actual: `${Math.round(ageMs / 60_000)} minutes old`,
      difference: `${Math.round((ageMs - allowedMs) / 60_000)} minutes beyond tolerance`,
      severity: 'HIGH',
      violatedContract: 'market-state capture writes on its interval during market hours',
      rootCause: null,
      assertionKey: 'capture.staleness',
      proposedProtection: {
        type: 'MONITOR',
        title: 'Capture staleness during market hours',
        rule: 'report_as_of - max(oi_snapshots.time) <= 3 * captureIntervalMinutes while market open',
        implementedIn: 'apps/server/src/services/system-learning-audit.ts',
      },
      evidence: {
        reportAsOf: input.reportAsOf,
        lastSnapshotAt: input.lastSnapshotAt,
        captureIntervalMinutes: input.captureIntervalMinutes,
      },
    });
    if (f) out.findings.push(f);
  }
  return out;
}

// ============================================================
// DUPLICATES
// ============================================================

export function detectDuplicateFaults(duplicates: {
  table: string;
  key: string;
  n: number;
}[] | null): DetectorResult {
  const out: DetectorResult = { detector: 'duplicates', findings: [], error: null };
  if (duplicates == null) {
    out.error = 'the duplicate scan did not run';
    return out;
  }
  for (const d of duplicates) {
    if (d.n <= 0) continue;
    const f = makeFinding({
      category: 'DUPLICATE_DATA',
      module: d.table,
      component: d.key,
      fault: 'DUPLICATE_ROWS_FOR_UNIQUE_KEY',
      scope: `${d.table}_${d.key}`,
      title: `Duplicate rows in ${d.table} for ${d.key}`,
      description: `${d.n} duplicate group(s) share a key that should identify one row, so any count over this table double-counts.`,
      expected: `one row per (${d.key}) in ${d.table}`,
      actual: `${d.n} duplicate group(s)`,
      difference: String(d.n),
      severity: 'HIGH',
      violatedContract: `uniqueness of (${d.key}) in ${d.table}`,
      rootCause: null,
      assertionKey: `duplicates.${d.table}.${d.key}`,
      proposedProtection: {
        type: 'RECONCILIATION',
        title: `No duplicate ${d.key} in ${d.table}`,
        rule: `SELECT ${d.key} FROM ${d.table} GROUP BY ${d.key} HAVING COUNT(*) > 1 returns no rows`,
        implementedIn: 'apps/server/src/services/system-learning-audit.ts',
      },
      evidence: { duplicate: d },
    });
    if (f) out.findings.push(f);
  }
  return out;
}

/** Every detector, so the audit run can report how many ran and how many failed. */
export const DETECTOR_NAMES = [
  'population_reconciliation',
  'report_boundary',
  'population_contract',
  'lineage_contract',
  'data_quality',
  'capture_schema',
  'protected_constants',
  'run_snapshot_relationship',
  'capture_staleness',
  'duplicates',
] as const;
