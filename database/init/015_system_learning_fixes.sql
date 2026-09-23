-- ============================================================
-- SYSTEM LEARNING FIXES
-- ============================================================
-- Additive, idempotent, backward compatible. 014 is already applied in
-- production and is not rewritten.
--
-- Observability only. No captured table is touched, no captured row is
-- updated or deleted, and nothing here is read by the trading engine.
--
-- FOUR THINGS THIS ADDS
--
-- 1. CONTRACT AWARENESS. The engine learned "zero is bad". The correct
--    lesson is narrower: a zero under LEGACY_ZERO_MAPPING is the contract
--    working as designed, and a zero under the current contract is a defect.
--    Same observation, opposite verdict, decided by the generation the row
--    belongs to. A finding now carries that verdict, the generation that
--    produced it, and why.
--
-- 2. TWO COUNTERS INSTEAD OF ONE. occurrence_count conflated "days this
--    fault was seen" with "times the audit ran while it was open". Polling
--    the manual endpoint during verification took seven faults to 136
--    apiece. Both numbers are worth having; only one of them is recurrence.
--
-- 3. EVIDENCE QUALITY. Separate from severity. A CRITICAL finding with
--    INSUFFICIENT evidence must not resolve, and a finding whose cause is
--    proven by a stamped column is not the same claim as one inferred.
--
-- 4. IDEMPOTENCY. A logical audit is (date, type, version). Running it
--    twice completes once.
-- ============================================================

-- ------------------------------------------------------------
-- 1 · CONTRACT-AWARE CLASSIFICATION
-- ------------------------------------------------------------

-- The verdict on the observation, as distinct from its severity.
--   DEFECT                        violates the contract in force
--   EXPECTED_UNDER_LEGACY_CONTRACT  valid under the generation that wrote it
--   EXPECTED_BEHAVIOR             valid under the current contract
--   NEEDS_CONTRACT_REVIEW         generation unknown; a person decides
ALTER TABLE system_learning_events ADD COLUMN IF NOT EXISTS classification VARCHAR(40);

-- Why that verdict. Never a bare label: the report has to be able to answer
-- "which contract generation makes this valid?" from the row itself.
ALTER TABLE system_learning_events ADD COLUMN IF NOT EXISTS classification_reason TEXT;

-- The authoritative generation the affected rows belong to, from
-- classifyGeneration() — stamped column first, contract fields second,
-- cutover only as a fallback.
ALTER TABLE system_learning_events ADD COLUMN IF NOT EXISTS contract_generation VARCHAR(40);

-- TRUE when the contract in force for those rows permits what was observed.
ALTER TABLE system_learning_events ADD COLUMN IF NOT EXISTS expected_by_contract BOOLEAN;

-- How well the evidence supports the stated cause: HIGH, MEDIUM, LOW,
-- INSUFFICIENT. Separate from severity, and from root_cause_confidence,
-- which describes the cause rather than the evidence for it.
ALTER TABLE system_learning_events ADD COLUMN IF NOT EXISTS evidence_quality VARCHAR(20);

-- Verification is its own step. "fix_applied" is not proof of protection,
-- and a protection existing is not proof it works.
ALTER TABLE system_learning_events ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30);
ALTER TABLE system_learning_events ADD COLUMN IF NOT EXISTS verification_note TEXT;
ALTER TABLE system_learning_events ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_learning_classification
  ON system_learning_events(classification);
CREATE INDEX IF NOT EXISTS idx_learning_generation
  ON system_learning_events(contract_generation);
CREATE INDEX IF NOT EXISTS idx_learning_evidence_quality
  ON system_learning_events(evidence_quality);

-- ------------------------------------------------------------
-- 2 · TWO COUNTERS
-- ------------------------------------------------------------

-- Times the audit observed this fault, across all runs. Useful, but it is a
-- measure of how often the audit ran, not of how persistent the fault is.
ALTER TABLE system_learning_events ADD COLUMN IF NOT EXISTS audit_runs_seen INTEGER;

-- Distinct audit DAYS the fault was seen. This is the recurrence number, and
-- the only one the UI and the reports may use for recurrence.
ALTER TABLE system_learning_events ADD COLUMN IF NOT EXISTS audit_days_seen INTEGER;

-- Back-fill both from the occurrence history that already exists, rather
-- than guessing or overwriting. system_learning_occurrences holds one row per
-- sighting with its event_date, so both numbers are derivable exactly.
--
-- Guarded so it runs once: a row that already carries audit_days_seen is left
-- alone, which makes re-applying this file on every boot harmless.
UPDATE system_learning_events e
SET audit_runs_seen = d.runs,
    audit_days_seen = d.days
FROM (
  SELECT event_id, COUNT(*) AS runs, COUNT(DISTINCT event_date) AS days
  FROM system_learning_occurrences
  GROUP BY event_id
) d
WHERE e.event_id = d.event_id
  AND e.audit_days_seen IS NULL;

-- An event with no occurrence rows at all (impossible via the engine, but
-- possible if a row were inserted by hand) gets the honest minimum.
UPDATE system_learning_events
SET audit_runs_seen = COALESCE(audit_runs_seen, 1),
    audit_days_seen = COALESCE(audit_days_seen, 1)
WHERE audit_days_seen IS NULL OR audit_runs_seen IS NULL;

-- ------------------------------------------------------------
-- 3 · AUDIT IDEMPOTENCY
-- ------------------------------------------------------------

-- A logical audit is (date, type, version). Re-running it must complete
-- once, not append a second run that doubles every count derived from runs.
ALTER TABLE system_audit_runs ADD COLUMN IF NOT EXISTS audit_type VARCHAR(40);
ALTER TABLE system_audit_runs ADD COLUMN IF NOT EXISTS audit_version VARCHAR(20);
-- Named trigger_source, not "trigger": TRIGGER is a reserved word in
-- Postgres and the unquoted form is a syntax error.
ALTER TABLE system_audit_runs ADD COLUMN IF NOT EXISTS trigger_source VARCHAR(20);
-- TRUE when this row was short-circuited because the logical audit had
-- already completed. Recorded rather than silently skipped, so a reader can
-- see that the audit was asked for and correctly declined.
ALTER TABLE system_audit_runs ADD COLUMN IF NOT EXISTS already_completed BOOLEAN NOT NULL DEFAULT FALSE;
-- Whether the source data the audit needs was ready. An audit that ran early
-- and found staleness because of its own earliness is worse than no audit.
ALTER TABLE system_audit_runs ADD COLUMN IF NOT EXISTS source_data_ready BOOLEAN;
ALTER TABLE system_audit_runs ADD COLUMN IF NOT EXISTS source_data_note TEXT;

UPDATE system_audit_runs
SET audit_type = COALESCE(audit_type, 'SYSTEM_LEARNING'),
    audit_version = COALESCE(audit_version, 'v1')
WHERE audit_type IS NULL OR audit_version IS NULL;

-- Retrospectively mark redundant re-runs, so the unique index below can be
-- created at all.
--
-- The index failed on first application, and correctly: rows already existed
-- for the same logical audit because the endpoint was called repeatedly
-- during verification, before the idempotency check existed. Those later runs
-- WERE redundant — that is exactly what already_completed means — so labelling
-- them is the honest reading, not a workaround to get the index built.
--
-- The EARLIEST run per logical audit is kept as the authoritative one; every
-- later one is marked already_completed and thereby leaves the partial index's
-- predicate. Nothing is deleted, so the history of how often the audit ran
-- stays queryable.
UPDATE system_audit_runs r
SET already_completed = TRUE,
    source_data_note = COALESCE(
      source_data_note,
      'marked redundant by migration 015: an earlier run had already completed this logical audit (date, type, version)'
    )
FROM (
  SELECT event_date, audit_type, audit_version, MIN(audit_run_id) AS keep_id
  FROM system_audit_runs
  WHERE status IN ('SUCCESS', 'PARTIAL') AND already_completed = FALSE
  GROUP BY event_date, audit_type, audit_version
  HAVING COUNT(*) > 1
) d
WHERE r.event_date = d.event_date
  AND r.audit_type IS NOT DISTINCT FROM d.audit_type
  AND r.audit_version IS NOT DISTINCT FROM d.audit_version
  AND r.status IN ('SUCCESS', 'PARTIAL')
  AND r.already_completed = FALSE
  AND r.audit_run_id <> d.keep_id;

-- One COMPLETED logical audit per (date, type, version).
--
-- Partial so that RUNNING and FAILED rows do not block a retry: a failed
-- audit must be re-runnable, or one transient database error would cost a
-- day of the record.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_run_logical_once
  ON system_audit_runs(event_date, audit_type, audit_version)
  WHERE status IN ('SUCCESS', 'PARTIAL') AND already_completed = FALSE;

-- ------------------------------------------------------------
-- 4 · DURABLE REGRESSION FIXTURES
-- ------------------------------------------------------------
-- The existing cases evaluate an assertion against live audit output, which
-- is what makes "protection failed" detectable. That stays.
--
-- What it cannot do is reproduce the fault deterministically once the live
-- data has moved on. These columns store the minimum needed for that: the
-- input that produced the fault, and the three results. No new test
-- framework — the repository has vitest configured and no test files, so a
-- fixture here is a row a future test can read, not a parallel runner.
ALTER TABLE system_regression_cases ADD COLUMN IF NOT EXISTS fixture JSONB;
ALTER TABLE system_regression_cases ADD COLUMN IF NOT EXISTS input_condition TEXT;
ALTER TABLE system_regression_cases ADD COLUMN IF NOT EXISTS deterministic BOOLEAN NOT NULL DEFAULT FALSE;
-- OPEN_NEVER_PASSED is recorded explicitly rather than inferred from
-- pass_count, so a reader of the table alone can tell an open fault from a
-- regression without recomputing the distinction.
ALTER TABLE system_regression_cases ADD COLUMN IF NOT EXISTS never_passed BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE system_regression_cases
SET never_passed = (pass_count = 0)
WHERE never_passed IS DISTINCT FROM (pass_count = 0);

CREATE INDEX IF NOT EXISTS idx_regression_never_passed
  ON system_regression_cases(never_passed) WHERE never_passed = TRUE;

-- ------------------------------------------------------------
-- 5 · RECLASSIFY THE SEVEN HISTORICAL ZERO FINDINGS
-- ------------------------------------------------------------
-- These were correct OBSERVATIONS with the wrong VERDICT. The detector had
-- learned "zero is bad"; under LEGACY_ZERO_MAPPING absence was stored as
-- zero, so those zeros are that contract working as designed.
--
-- They are reclassified, not deleted and not suppressed. Everything that made
-- them auditable is left exactly as it was: detected_at, error_signature,
-- evidence, actual_value, first_seen_at, occurrence_count and the full
-- occurrence history. After this the record can still answer "why was this
-- originally detected?" as well as "why is it now considered expected?".
--
-- EVIDENCE-GUARDED. The reclassification only applies to a column whose zeros
-- are confined to the pre-cutover population: if a single zero exists at or
-- after data_quality_cutover_at, the legacy contract does not explain it and
-- the row is left alone for a person. That check is the difference between
-- reclassifying on evidence and whitelisting zeros.
--
-- Idempotent: rows that already carry a classification are skipped.
WITH legacy_only AS (
  SELECT
    col,
    SUM(CASE WHEN post THEN zeros ELSE 0 END) AS post_zeros,
    SUM(CASE WHEN post THEN 0 ELSE zeros END) AS pre_zeros
  FROM (
    SELECT 'BID' AS col, (time >= TIMESTAMPTZ '2026-09-21T16:05:00Z') AS post,
           COUNT(*) FILTER (WHERE bid = 0) AS zeros FROM oi_snapshots GROUP BY 2
    UNION ALL
    SELECT 'ASK', (time >= TIMESTAMPTZ '2026-09-21T16:05:00Z'),
           COUNT(*) FILTER (WHERE ask = 0) FROM oi_snapshots GROUP BY 2
    UNION ALL
    SELECT 'IV', (time >= TIMESTAMPTZ '2026-09-21T16:05:00Z'),
           COUNT(*) FILTER (WHERE iv = 0) FROM oi_snapshots GROUP BY 2
    UNION ALL
    SELECT 'DELTA', (time >= TIMESTAMPTZ '2026-09-21T16:05:00Z'),
           COUNT(*) FILTER (WHERE delta = 0) FROM oi_snapshots GROUP BY 2
    UNION ALL
    SELECT 'GAMMA', (time >= TIMESTAMPTZ '2026-09-21T16:05:00Z'),
           COUNT(*) FILTER (WHERE gamma = 0) FROM oi_snapshots GROUP BY 2
    UNION ALL
    SELECT 'THETA', (time >= TIMESTAMPTZ '2026-09-21T16:05:00Z'),
           COUNT(*) FILTER (WHERE theta = 0) FROM oi_snapshots GROUP BY 2
    UNION ALL
    SELECT 'VEGA', (time >= TIMESTAMPTZ '2026-09-21T16:05:00Z'),
           COUNT(*) FILTER (WHERE vega = 0) FROM oi_snapshots GROUP BY 2
  ) z
  GROUP BY col
)
UPDATE system_learning_events e
SET classification = 'EXPECTED_UNDER_LEGACY_CONTRACT',
    classification_reason =
      'Reclassified from evidence: all ' || l.pre_zeros || ' zero(s) in this column predate '
      || 'data_quality_cutover_at (2026-09-21T16:05:00Z), and 0 exist at or after it. Those rows '
      || 'belong to LEGACY_ZERO_MAPPING, whose contract stored absence AS zero — so the '
      || 'observation is that contract working as designed, not a violation of it. Originally '
      || 'detected because the detector tested for zeros without regard to the generation that '
      || 'wrote them.',
    contract_generation = 'LEGACY_ZERO_MAPPING',
    expected_by_contract = TRUE,
    evidence_quality = 'HIGH',
    status = 'EXPECTED',
    root_cause = 'rows belong to LEGACY_ZERO_MAPPING, where absence was stored as zero by contract',
    root_cause_confidence = 'HIGH',
    fix_required = FALSE,
    updated_at = NOW()
FROM legacy_only l
WHERE e.error_signature = 'DATA_QUALITY:SUSPICIOUS_ZERO_DISTRIBUTION:' || l.col
  AND l.post_zeros = 0
  AND e.classification IS NULL;

-- The regression cases created for those findings assert that the zeros do not
-- exist. Against data that is supposed to be there they would fail forever and
-- report as a regression every cycle. Retired, with the reason on the row.
UPDATE system_regression_cases c
SET status = 'RETIRED_EXPECTED',
    current_behavior =
      'retired: the observation is expected under LEGACY_ZERO_MAPPING, so this assertion would '
      || 'fail forever against data that is supposed to be present',
    updated_at = NOW()
FROM system_learning_events e
WHERE c.error_signature = e.error_signature
  AND e.classification = 'EXPECTED_UNDER_LEGACY_CONTRACT'
  AND c.status <> 'RETIRED_EXPECTED';
