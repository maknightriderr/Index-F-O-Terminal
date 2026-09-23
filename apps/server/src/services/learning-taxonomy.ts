// ============================================================
// LEARNING TAXONOMY
// ============================================================
// The vocabulary of the self-audit: what kinds of fault exist, what states a
// finding can be in, how a signature is built, and which findings may never
// be acted on without a human.
//
// Pure and dependency-free, in its own module, so every rule here can be
// exercised against constructed input without a database pool — the same
// reason the population model, the stop classifier and the contract model
// are separate.
//
// Nothing here is read by the trading engine.
// ============================================================

// ------------------------------------------------------------
// CATEGORIES
// ------------------------------------------------------------

/**
 * Category groups, so a report can answer "why did the system fail?" without
 * a second mapping maintained somewhere else.
 */
export const CATEGORY_GROUPS = {
  DATA: 'Data problem',
  LINEAGE: 'Lineage problem',
  FNO: 'F&O contract problem',
  CLASSIFICATION: 'Classification problem',
  SCANNER: 'Scanner problem',
  TIMING: 'Timing problem',
  TRADING: 'Trading-path problem',
  INTEGRATION: 'Integration problem',
  REGRESSION: 'Regression problem',
  CONFIGURATION: 'Configuration problem',
  UNKNOWN: 'Unknown',
} as const;

export type CategoryGroup = keyof typeof CATEGORY_GROUPS;

/**
 * Every known category and the group it rolls up to.
 *
 * The database column is free text on purpose: an unrecognised category is a
 * reporting gap, not a reason to drop a finding on insert. `categoryGroup()`
 * degrades to UNKNOWN rather than throwing.
 */
export const ERROR_CATEGORIES: Record<string, CategoryGroup> = {
  // data
  DATA_QUALITY: 'DATA',
  DATA_STALENESS: 'DATA',
  DUPLICATE_DATA: 'DATA',
  MISSING_DATA: 'DATA',
  POPULATION_MISMATCH: 'DATA',
  SNAPSHOT_MISMATCH: 'DATA',
  // lineage
  DATA_LINEAGE: 'LINEAGE',
  // timing
  TIMESTAMP_ERROR: 'TIMING',
  TIMING_ERROR: 'TIMING',
  // F&O contracts
  FNO_DATA: 'FNO',
  EXPIRY_MISMATCH: 'FNO',
  CONTRACT_MISMATCH: 'FNO',
  OPTION_CHAIN_MISMATCH: 'FNO',
  OI_DATA_ERROR: 'FNO',
  VOLUME_DATA_ERROR: 'FNO',
  // scanner
  SCANNER: 'SCANNER',
  SCANNER_MISS: 'SCANNER',
  FALSE_POSITIVE: 'SCANNER',
  FALSE_NEGATIVE: 'SCANNER',
  SIGNAL_CONFLICT: 'SCANNER',
  SIGNAL_STALE: 'SCANNER',
  SETUP_CLASSIFICATION_ERROR: 'CLASSIFICATION',
  // market context
  MARKET_CONTEXT: 'CLASSIFICATION',
  BIAS_ERROR: 'CLASSIFICATION',
  TREND_CLASSIFICATION_ERROR: 'CLASSIFICATION',
  STRUCTURE_CLASSIFICATION_ERROR: 'CLASSIFICATION',
  // trading path
  TRADING: 'TRADING',
  ENTRY_ERROR: 'TRADING',
  EXIT_ERROR: 'TRADING',
  SL_ERROR: 'TRADING',
  TARGET_ERROR: 'TRADING',
  COOLDOWN_ERROR: 'TRADING',
  // system
  SYSTEM: 'INTEGRATION',
  REGRESSION: 'REGRESSION',
  CONFIGURATION: 'CONFIGURATION',
  INTEGRATION: 'INTEGRATION',
  PERFORMANCE: 'INTEGRATION',
  UNKNOWN: 'UNKNOWN',
};

export function categoryGroup(category: string): CategoryGroup {
  return ERROR_CATEGORIES[category] ?? 'UNKNOWN';
}

export function isKnownCategory(category: string): boolean {
  return category in ERROR_CATEGORIES;
}

// ------------------------------------------------------------
// THE TRADING-LOGIC GATE
// ------------------------------------------------------------

/**
 * Categories whose remedy touches a trading decision.
 *
 * A finding in any of these may be detected, explained, root-caused and have
 * a fix PROPOSED — and there it stops until a human approves. There is no
 * code path from proposal to applied that does not pass through the approval
 * columns.
 */
export const TRADING_LOGIC_CATEGORIES: readonly string[] = [
  'ENTRY_ERROR',
  'EXIT_ERROR',
  'SL_ERROR',
  'TARGET_ERROR',
  'COOLDOWN_ERROR',
  'TRADING',
  'BIAS_ERROR',
  'SETUP_CLASSIFICATION_ERROR',
  'TREND_CLASSIFICATION_ERROR',
  'STRUCTURE_CLASSIFICATION_ERROR',
  'MARKET_CONTEXT',
  'SCANNER_MISS',
  'FALSE_POSITIVE',
  'FALSE_NEGATIVE',
  'SIGNAL_CONFLICT',
];

/**
 * The modules a self-audit may never edit on its own.
 *
 * Listed by path so the check is mechanical rather than a matter of
 * remembering which file counts as strategy.
 */
export const HUMAN_APPROVAL_MODULES: readonly string[] = [
  'market-bias',
  'trade-setup',
  'risk-circuit-breaker',
  'trade-health',
  'market-scanner',
  'fno-scanner',
  'positional-stock-scan',
  'option-chain',
  'location-quality',
  'stop-event',
  'trade-setup-monitor',
  'strategy-tracker',
  'next-day-model',
];

/**
 * The only changes this engine may make by itself.
 *
 * Everything here is observation, validation or reporting — it can change
 * what the system NOTICES, never what it DOES.
 */
export const AUTO_SAFE_SCOPES: readonly string[] = [
  'DATA_VALIDATION',
  'DATA_RECONCILIATION',
  'DUPLICATE_DETECTION',
  'MISSING_DATA_DETECTION',
  'TIMESTAMP_VALIDATION',
  'LINEAGE_VALIDATION',
  'MONITORING',
  'REPORTING',
  'LOGGING',
  'REGRESSION_TEST',
  'INVARIANT',
  'ERROR_CLASSIFICATION',
];

/**
 * Whether a finding needs a human before anything is applied.
 *
 * Deliberately conservative in both inputs: either a trading-path category
 * or a trading-path module is enough. A finding that is arguably in the
 * trading path is treated as in it.
 */
export function requiresHumanApproval(input: { category: string; module?: string | null }): boolean {
  if (TRADING_LOGIC_CATEGORIES.includes(input.category)) return true;
  const module = input.module ?? '';
  return HUMAN_APPROVAL_MODULES.some((m) => module.includes(m));
}

/** Whether a proposed remedy is one the engine may apply unattended. */
export function isAutoSafeScope(scope: string): boolean {
  return AUTO_SAFE_SCOPES.includes(scope);
}

// ------------------------------------------------------------
// SEVERITY
// ------------------------------------------------------------

export const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(s: string): number {
  const i = (SEVERITIES as readonly string[]).indexOf(s);
  return i < 0 ? 0 : i;
}

// ------------------------------------------------------------
// STATES
// ------------------------------------------------------------

export const LEARNING_STATES = [
  'DETECTED',
  'TRIAGED',
  'NEW',
  'KNOWN',
  'FIX_PROPOSED',
  'FIXED',
  'PROTECTED',
  'REGRESSION_PASSED',
  'MONITORING',
  'RECURRENCE',
  'NEEDS_HUMAN_REVIEW',
  'RESOLVED',
  /**
   * The observation is real and the contract in force permits it.
   *
   * A first-class outcome, not a dismissal. The engine's original lesson was
   * "zero is bad"; the correct one is that a zero under LEGACY_ZERO_MAPPING
   * is that contract working as designed. Such a finding must not sit in
   * NEEDS_HUMAN_REVIEW forever, and must not be counted as an unresolved
   * defect, a regression failure or a protection failure — but it must stay
   * on the record with its evidence, so a later contract change can make it
   * a defect again.
   */
  'EXPECTED',
  /** Reviewed by a person and judged not to be a fault. Terminal. */
  'CLOSED_EXPECTED',
] as const;
export type LearningState = (typeof LEARNING_STATES)[number];

/**
 * States that mean "no longer counted as an open defect".
 *
 * EXPECTED is here because a finding the contract permits is not a defect.
 * It is NOT the same as resolved: nothing was fixed, and if the contract
 * governing those rows changes, the same observation becomes a defect again.
 */
export const TERMINAL_STATES: readonly LearningState[] = ['RESOLVED', 'CLOSED_EXPECTED', 'EXPECTED'];

/** States that mean "the contract permits this", for reporting. */
export const EXPECTED_STATES: readonly LearningState[] = ['EXPECTED', 'CLOSED_EXPECTED'];

export function isExpected(status: string): boolean {
  return (EXPECTED_STATES as readonly string[]).includes(status);
}

export function isOpen(status: string): boolean {
  return !(TERMINAL_STATES as readonly string[]).includes(status);
}

/**
 * What must be true before a finding may be called RESOLVED.
 *
 * The symptom disappearing is explicitly not enough. An intermittent fault
 * is absent most of the time, so "not currently firing" would resolve
 * everything that matters and nothing that is actually fixed.
 */
export interface ResolutionEvidence {
  rootCause: string | null;
  fixApplied: boolean;
  fixDescription: string | null;
  protectionId: string | null;
  /** PASS, FAIL or null when no regression case applies. */
  regressionStatus: string | null;
  /** True when the category can carry a protection at all. */
  protectionApplicable: boolean;
  humanApprovalRequired: boolean;
  humanApproved: boolean;
  /** How well the evidence supports the stated cause. */
  evidenceQuality?: string | null;
  /** Set when the contract in force permits the observation. */
  expectedByContract?: boolean;
  /** Whether the protection has been verified to work, as opposed to existing. */
  verificationStatus?: string | null;
}

export interface ResolutionVerdict {
  canResolve: boolean;
  /** Where it should sit instead, when it cannot resolve. */
  suggestedStatus: LearningState;
  blockers: string[];
}

export function canResolve(e: ResolutionEvidence): ResolutionVerdict {
  const blockers: string[] = [];

  // An observation the contract permits is not a defect, so the defect
  // checklist does not apply to it. It goes to EXPECTED with its evidence
  // rather than being held open against a fix that should never be written.
  if (e.expectedByContract === true) {
    return { canResolve: false, suggestedStatus: 'EXPECTED', blockers: [] };
  }

  if (e.rootCause == null || e.rootCause.trim() === '') {
    blockers.push('root cause is not established — a finding with an unknown cause has not been understood, only stopped being noisy');
  }
  if (!e.fixApplied || e.fixDescription == null || e.fixDescription.trim() === '') {
    blockers.push('no fix is recorded — nothing describes what changed, so nothing can be reviewed or reverted');
  }
  if (e.protectionApplicable && (e.protectionId == null || e.protectionId.trim() === '')) {
    blockers.push('no protection is recorded — without one the next occurrence starts the same investigation from zero');
  }
  if (e.regressionStatus === 'FAIL') {
    blockers.push('the regression case for this fault is currently FAILING');
  }
  if (e.humanApprovalRequired && !e.humanApproved) {
    blockers.push('this finding is in the trading path and has not been approved by a human');
  }
  // Evidence quality is checked separately from the cause being written down:
  // a cause can be recorded and still rest on nothing.
  if (e.evidenceQuality != null && !evidenceSupportsClosure(e.evidenceQuality)) {
    blockers.push(
      `evidence quality is ${e.evidenceQuality} — closing on this would stop the finding being looked at while the cause is still unestablished`
    );
  }
  // A protection existing is not a protection working. Verification is its
  // own step, and "fix applied" is not proof of either.
  if (e.protectionId != null && e.verificationStatus === 'FAILED') {
    blockers.push('the protection for this fault has been verified as NOT working');
  }

  // An unknown root cause is the one blocker that changes where the finding
  // goes rather than merely keeping it open: it needs a person, not time.
  const needsHuman =
    e.rootCause == null ||
    e.rootCause.trim() === '' ||
    (e.humanApprovalRequired && !e.humanApproved);

  return {
    canResolve: blockers.length === 0,
    suggestedStatus: blockers.length === 0
      ? 'RESOLVED'
      : needsHuman
        ? 'NEEDS_HUMAN_REVIEW'
        : e.protectionId
          ? 'MONITORING'
          : 'FIX_PROPOSED',
    blockers,
  };
}

// ------------------------------------------------------------
// CONTRACT-AWARE CLASSIFICATION
// ------------------------------------------------------------

/**
 * The verdict on an observation, as distinct from its severity.
 *
 * Severity says how much it would matter if it were wrong. This says whether
 * it is wrong at all — which depends entirely on the contract in force for
 * the rows involved.
 */
export const CLASSIFICATIONS = {
  DEFECT: 'violates the data contract in force for the rows involved',
  EXPECTED_UNDER_LEGACY_CONTRACT:
    'valid under the contract generation that wrote these rows, which is not the current one',
  EXPECTED_BEHAVIOR: 'valid under the current contract',
  NEEDS_CONTRACT_REVIEW:
    'the contract generation could not be determined, so whether this is a defect is unknown',
} as const;

export type Classification = keyof typeof CLASSIFICATIONS;

export interface ContractVerdict {
  classification: Classification;
  reason: string;
  expectedByContract: boolean;
  /** Where the finding should sit given the verdict. */
  suggestedStatus: LearningState;
  evidenceQuality: EvidenceQuality;
}

/**
 * Classifies an observation against the generation that produced it.
 *
 *   LEGACY_ZERO_MAPPING       -> EXPECTED_UNDER_LEGACY_CONTRACT
 *   current contract          -> DEFECT
 *   UNCLASSIFIED / unknown    -> NEEDS_CONTRACT_REVIEW
 *
 * `contractualUnderGeneration` is supplied by the audit that owns the
 * measurement, not decided here: this function does not know what any
 * particular contract permits, only how to act on the answer. That keeps the
 * rule from being a second, drifting copy of the contract definitions.
 *
 * Note what this deliberately does NOT do: it never marks an observation
 * expected merely because it is old, or because the value is a zero. Only an
 * identified generation whose contract permits the observation qualifies.
 */
export function classifyAgainstContract(input: {
  generation: string | null;
  /** Whether that generation's contract permits what was observed. */
  contractualUnderGeneration: boolean;
  /** How the generation was established — from a stamped column, or inferred. */
  generationReason: string | null;
}): ContractVerdict {
  const gen = input.generation;

  if (gen == null || gen === 'UNCLASSIFIED' || gen.trim() === '') {
    return {
      classification: 'NEEDS_CONTRACT_REVIEW',
      reason:
        'the contract generation for the affected rows could not be determined, so whether the observation violates anything is unknown. Not assumed either way.',
      expectedByContract: false,
      suggestedStatus: 'NEEDS_HUMAN_REVIEW',
      evidenceQuality: 'INSUFFICIENT',
    };
  }

  if (input.contractualUnderGeneration) {
    const stamped = (input.generationReason ?? '').includes('stamped on the row');
    return {
      classification:
        gen === 'LEGACY_ZERO_MAPPING' ? 'EXPECTED_UNDER_LEGACY_CONTRACT' : 'EXPECTED_BEHAVIOR',
      reason: `the affected rows belong to ${gen}, whose contract permits this observation (${input.generationReason ?? 'generation established'})`,
      expectedByContract: true,
      suggestedStatus: 'EXPECTED',
      // A stamped generation is a recorded fact; an inferred one rests on a
      // cutover comparison, which is weaker and says so.
      evidenceQuality: stamped ? 'HIGH' : 'MEDIUM',
    };
  }

  return {
    classification: 'DEFECT',
    reason: `the affected rows belong to ${gen}, whose contract does NOT permit this observation (${input.generationReason ?? 'generation established'})`,
    expectedByContract: false,
    suggestedStatus: 'NEW',
    evidenceQuality: 'HIGH',
  };
}

// ------------------------------------------------------------
// EVIDENCE QUALITY
// ------------------------------------------------------------

export const EVIDENCE_QUALITIES = ['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT'] as const;
export type EvidenceQuality = (typeof EVIDENCE_QUALITIES)[number];

export const EVIDENCE_QUALITY_MEANING: Record<EvidenceQuality, string> = {
  HIGH: 'a stamped column or an explicit contract field decides it; no inference involved',
  MEDIUM: 'established by comparison against an authoritative marker or cutover, not by a stamped field',
  LOW: 'consistent with the available evidence but not established by it',
  INSUFFICIENT: 'the evidence does not support any stated cause',
};

/**
 * Whether the evidence is strong enough to close a finding.
 *
 * INSUFFICIENT never is. A finding resolved on insufficient evidence is worse
 * than one left open, because it stops being looked at while the cause is
 * still unknown.
 */
export function evidenceSupportsClosure(q: string | null): boolean {
  return q === 'HIGH' || q === 'MEDIUM';
}

// ------------------------------------------------------------
// PROTECTION TYPES
// ------------------------------------------------------------

export const PROTECTION_TYPES = [
  'INVARIANT',
  'REGRESSION_TEST',
  'VALIDATION_RULE',
  'MONITOR',
  'ALERT',
  'DATA_CONTRACT',
  'ASSERTION',
  'RECONCILIATION',
  'UNIT_TEST',
  'INTEGRATION_TEST',
] as const;
export type ProtectionType = (typeof PROTECTION_TYPES)[number];

/**
 * Categories for which a protection is expected.
 *
 * A category absent here can still carry one, but its absence will not block
 * resolution — some faults (a third-party feed being down) have no
 * protection this system can build, and demanding one would either stall the
 * record forever or invite a fake entry.
 */
export const PROTECTION_APPLICABLE_GROUPS: readonly CategoryGroup[] = [
  'DATA', 'LINEAGE', 'FNO', 'TIMING', 'REGRESSION', 'CONFIGURATION',
];

export function protectionApplicable(category: string): boolean {
  return PROTECTION_APPLICABLE_GROUPS.includes(categoryGroup(category));
}

// ------------------------------------------------------------
// SIGNATURES
// ------------------------------------------------------------

/**
 * Builds the deterministic signature for a fault.
 *
 * The signature names the LOGICAL fault and must contain no measured value.
 * `POPULATION_MISMATCH:HISTORICAL_PRE_POST_RECONCILIATION` collides with
 * itself next week; `POPULATION_MISMATCH:906_40_868` never collides with
 * anything, so every occurrence looks new, occurrence_count stays at 1
 * forever and recurrence detection silently does nothing.
 *
 * Scope is for a fault that is genuinely per-instrument — a chain that is
 * short only for CRUDEOIL is a different fault from one short everywhere.
 * It is normalised, and numbers in it are rejected for the same reason.
 */
export function buildSignature(input: {
  category: string;
  fault: string;
  scope?: string | null;
}): string {
  const norm = (s: string) =>
    s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const parts = [norm(input.category), norm(input.fault)];
  if (input.scope != null && input.scope.trim() !== '') parts.push(norm(input.scope));
  return parts.join(':');
}

/**
 * Whether a signature is value-free, and therefore able to detect recurrence.
 *
 * A bare integer anywhere in a signature means a measured value leaked in.
 * Version-like tokens (V1, PHASE2, BLACK_SCHOLES_MERTON) are legitimate
 * names, so a digit attached to letters is allowed; a standalone run of
 * digits is not.
 */
export function isStableSignature(signature: string): { stable: boolean; reason: string | null } {
  if (!/^[A-Z0-9_]+(:[A-Z0-9_]+)+$/.test(signature)) {
    return { stable: false, reason: 'signature must be uppercase tokens separated by ":"' };
  }
  const bareNumber = signature
    .split(/[:_]/)
    .find((t) => /^\d+$/.test(t));
  if (bareNumber != null) {
    return {
      stable: false,
      reason: `signature contains the bare value "${bareNumber}" — a signature carrying a measured value never collides with its own next occurrence, so recurrence can never be detected`,
    };
  }
  if (/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}/.test(signature)) {
    return { stable: false, reason: 'signature contains a timestamp' };
  }
  return { stable: true, reason: null };
}

// ------------------------------------------------------------
// WHAT IS NOT A SYSTEM ERROR
// ------------------------------------------------------------

/**
 * Outcomes that must never be recorded as system faults.
 *
 * A losing trade is not a defect. A stop that filled and then saw price
 * recover is not a defect. Treating either as one would turn this engine
 * into a hindsight machine that proposes strategy changes after every
 * adverse outcome — which is the opposite of what it is for, and would put
 * the trading path under continuous pressure from noise.
 */
export const NOT_SYSTEM_ERRORS: readonly string[] = [
  'NORMAL_MARKET_VOLATILITY',
  'NORMAL_SIGNAL_CHANGE',
  'TRADE_LOST_MONEY',
  'EXPECTED_SL_EXECUTION',
  'EXPECTED_SETUP_INVALIDATION',
  'NORMAL_SCANNER_DISAGREEMENT',
  'NORMAL_OPTION_CHAIN_CHANGE',
  'STOP_THEN_RECOVERY',
];

export interface ContractViolationClaim {
  /** The named contract, invariant, rule or documented behaviour breached. */
  violatedContract: string | null;
  /** What that contract required. */
  expected: string | null;
  /** What was observed instead. */
  actual: string | null;
  /** True when the claim rests only on knowing how the market later moved. */
  hindsightOnly: boolean;
}

export interface SystemErrorVerdict {
  isSystemError: boolean;
  reason: string;
}

/**
 * The gate every candidate finding passes before it becomes a record.
 *
 * A finding qualifies only when it names a contract that was breached, with
 * both sides of the comparison. "The setup lost" names nothing; "the signal
 * was generated from an option chain older than the staleness contract
 * allows" names a rule, an expectation and an observation.
 */
export function qualifiesAsSystemError(claim: ContractViolationClaim): SystemErrorVerdict {
  if (claim.hindsightOnly) {
    return {
      isSystemError: false,
      reason:
        'the claim rests only on later price action. A trading outcome is not a system fault, and treating it as one would let hindsight drive changes to the trading path.',
    };
  }
  if (claim.violatedContract == null || claim.violatedContract.trim() === '') {
    return {
      isSystemError: false,
      reason:
        'no contract, invariant, rule or documented behaviour is named as violated. Without one there is nothing to be wrong against.',
    };
  }
  if (claim.expected == null || claim.actual == null) {
    return {
      isSystemError: false,
      reason: 'a violation needs both what was required and what was observed; one side is missing.',
    };
  }
  if (String(claim.expected) === String(claim.actual)) {
    return { isSystemError: false, reason: 'expected and actual agree, so nothing was violated.' };
  }
  return {
    isSystemError: true,
    reason: `violates ${claim.violatedContract}: expected ${claim.expected}, observed ${claim.actual}`,
  };
}

// ------------------------------------------------------------
// LEARNING EFFECTIVENESS
// ------------------------------------------------------------

export interface LearningStats {
  unique_error_classes: number;
  protected_classes: number;
  regression_covered_classes: number;
  /** Classes seen on more than one audit DAY. Never audit runs. */
  recurring_classes: number;
  protection_failures: number;
  unresolved_classes: number;
  resolved_classes: number;
  needs_human_review: number;
  /** Distinct audit days summed across classes. */
  total_occurrences: number;
  /** Classes the contract in force permits. Not defects. */
  expected_classes?: number;
  /**
   * Protected classes that came back anyway.
   *
   * The only honest measure of a protection that does not work: a protection
   * existing says nothing, and a fix being applied says nothing either.
   */
  recurring_after_protection?: number;
  /** Times the audit observed findings, across all runs. Not recurrence. */
  total_audit_runs_seen?: number;
}

/**
 * The counts, and the two ratios that are actually defined.
 *
 * Deliberately not a single composite score. A made-up weighting of these
 * numbers would look authoritative and mean nothing, and the one number
 * would then be optimised instead of the system.
 */
export function learningEffectiveness(s: LearningStats): {
  stats: LearningStats;
  protection_coverage: number | null;
  regression_coverage: number | null;
  recurrence_rate: number | null;
  average_occurrences_per_class: number | null;
  formula: Record<string, string>;
} {
  const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
  return {
    stats: s,
    protection_coverage: pct(s.protected_classes, s.unique_error_classes),
    regression_coverage: pct(s.regression_covered_classes, s.unique_error_classes),
    recurrence_rate: pct(s.recurring_classes, s.unique_error_classes),
    average_occurrences_per_class:
      s.unique_error_classes === 0
        ? null
        : Math.round((s.total_occurrences / s.unique_error_classes) * 100) / 100,
    formula: {
      protection_coverage: 'protected_classes / unique_error_classes * 100',
      regression_coverage: 'regression_covered_classes / unique_error_classes * 100',
      recurrence_rate: 'recurring_classes / unique_error_classes * 100',
      average_occurrences_per_class: 'total_occurrences / unique_error_classes',
      recurring_classes: 'classes seen on more than one audit DAY — never a count of audit runs',
      recurring_after_protection:
        'classes with a protection recorded that were still seen on more than one day. This is protection ineffectiveness; a protection merely existing is not evidence it works, and neither is a fix having been applied.',
      expected_classes:
        'classes the contract in force permits. Counted apart from defects and excluded from unresolved.',
      total_audit_runs_seen:
        'times the audit observed findings across all runs. Reported for transparency and never used as recurrence.',
      note:
        'No composite score is published, and no "learning score" exists. These counts and four ratios are defined; a weighted blend of them would not be, and a single number invites optimising the number instead of the system.',
    },
  };
}

/** The threshold at which a recurring fault becomes a loud warning. */
export const REPEATED_FAILURE_THRESHOLD = 3;

export function isRepeatedFailure(occurrenceCount: number): boolean {
  return occurrenceCount >= REPEATED_FAILURE_THRESHOLD;
}
