-- ============================================================
-- SYSTEM LEARNING & SELF-AUDIT
-- ============================================================
-- Observability and self-audit only. Nothing here is read by the trading
-- engine, and nothing here can modify trading behaviour.
--
-- WHY THIS EXISTS
--
-- Every audit this system already runs answers "is it wrong now?". None of
-- them answers "has this been wrong before, did we fix it, and did the fix
-- hold?". A defect that is found, fixed and forgotten is indistinguishable
-- from one that was never found: the next occurrence starts the same
-- investigation from zero.
--
-- So a detected defect becomes a durable record keyed by a signature that
-- describes the LOGICAL fault rather than the values involved. The same fault
-- next week matches the same signature, and the record says what was done
-- about it last time — including that the protection put in place has now
-- demonstrably failed.
--
-- WHAT THIS DELIBERATELY CANNOT DO
--
-- It cannot change trading logic. Anything touching entry, exit, stops,
-- targets, risk, sizing, signal weights, confidence, bias, setup scoring,
-- option selection, cooldowns, eligibility or pattern interpretation is
-- recorded as a PROPOSAL requiring human approval, and the approval columns
-- are the only path from proposal to applied. There is no automatic path.
-- ============================================================

-- ------------------------------------------------------------
-- LEARNING EVENTS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_learning_events (
  event_id BIGSERIAL PRIMARY KEY,

  -- When this occurrence was observed, and the audit day it belongs to.
  -- event_date is IST-local so a daily report covers one trading day rather
  -- than one UTC day, which would split an Indian session in half.
  detected_at TIMESTAMPTZ NOT NULL,
  event_date DATE NOT NULL,

  -- Free text on purpose. A new category must not need a migration; the
  -- application owns the vocabulary and validates against it, so an unknown
  -- value is a reporting problem rather than an insert failure that loses
  -- the finding entirely.
  category VARCHAR(60) NOT NULL,
  module VARCHAR(80),
  component VARCHAR(120),
  symbol VARCHAR(40),
  expiry DATE,

  -- THE KEY. Deterministic, derived from the logical fault, never from the
  -- values. Two occurrences of the same fault must collide here or
  -- recurrence detection is worthless.
  error_signature VARCHAR(200) NOT NULL,
  error_title TEXT NOT NULL,
  description TEXT,

  -- What was expected against what was seen. Text because the comparison is
  -- sometimes numeric, sometimes a set, sometimes a timestamp.
  expected_value TEXT,
  actual_value TEXT,
  difference TEXT,

  severity VARCHAR(20) NOT NULL,

  -- NULL means not established. It must never be filled with a guess: a
  -- fabricated root cause closes an investigation that never happened.
  root_cause TEXT,
  root_cause_confidence VARCHAR(20),

  -- Recurrence bookkeeping, maintained by the engine.
  --
  -- occurrence_count counts DAYS the fault was seen, not audit cycles: two
  -- runs on one day are one occurrence. Counting cycles would make it a
  -- measure of how often somebody ran the audit while the fault was open,
  -- and "first seen 15 Sep, 8 occurrences" only means something if 8 is
  -- eight days. Individual sightings live in system_learning_occurrences.
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  previous_event_id BIGINT REFERENCES system_learning_events(event_id),

  fix_required BOOLEAN NOT NULL DEFAULT TRUE,
  fix_description TEXT,
  fix_applied BOOLEAN NOT NULL DEFAULT FALSE,
  fix_applied_at TIMESTAMPTZ,

  protection_type VARCHAR(40),
  protection_id VARCHAR(120),
  regression_test VARCHAR(200),
  regression_test_status VARCHAR(30),

  status VARCHAR(30) NOT NULL,

  -- The gate. TRUE for anything in the trading path; only an explicit human
  -- approval may move such a finding to applied.
  human_approval_required BOOLEAN NOT NULL DEFAULT FALSE,
  human_approved BOOLEAN NOT NULL DEFAULT FALSE,
  human_approved_at TIMESTAMPTZ,
  approved_by VARCHAR(120),
  review_decision VARCHAR(30),
  review_note TEXT,

  -- Provenance, so the finding can be reproduced rather than believed.
  source_run_id UUID,
  source_snapshot_id TEXT,
  source_commit VARCHAR(60),
  source_report_as_of TIMESTAMPTZ,
  evidence JSONB,
  environment VARCHAR(30),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One OPEN row per signature. Recurrence increments the existing row rather
-- than inserting a near-duplicate, which is what keeps occurrence_count
-- meaningful and stops the table growing one row per audit cycle.
CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_signature_open
  ON system_learning_events(error_signature)
  WHERE status NOT IN ('RESOLVED', 'CLOSED_EXPECTED');

CREATE INDEX IF NOT EXISTS idx_learning_signature ON system_learning_events(error_signature);
CREATE INDEX IF NOT EXISTS idx_learning_category ON system_learning_events(category);
CREATE INDEX IF NOT EXISTS idx_learning_status ON system_learning_events(status);
CREATE INDEX IF NOT EXISTS idx_learning_detected ON system_learning_events(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_event_date ON system_learning_events(event_date DESC);
CREATE INDEX IF NOT EXISTS idx_learning_module ON system_learning_events(module);
CREATE INDEX IF NOT EXISTS idx_learning_symbol ON system_learning_events(symbol);
CREATE INDEX IF NOT EXISTS idx_learning_commit ON system_learning_events(source_commit);
CREATE INDEX IF NOT EXISTS idx_learning_review
  ON system_learning_events(human_approval_required, human_approved)
  WHERE human_approval_required = TRUE;

-- ------------------------------------------------------------
-- OCCURRENCES
-- ------------------------------------------------------------
-- Every sighting, kept separately from the collapsed event row.
--
-- Without this, incrementing occurrence_count destroys the history it
-- counts: "seen 8 times" with no record of when, so a fault that stopped
-- three weeks ago looks identical to one firing every hour.
CREATE TABLE IF NOT EXISTS system_learning_occurrences (
  occurrence_id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES system_learning_events(event_id) ON DELETE CASCADE,
  error_signature VARCHAR(200) NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  event_date DATE NOT NULL,
  actual_value TEXT,
  difference TEXT,
  -- TRUE when this sighting arrived AFTER a protection was recorded, which
  -- is the only evidence that the protection does not work.
  after_protection BOOLEAN NOT NULL DEFAULT FALSE,
  protection_id VARCHAR(120),
  source_commit VARCHAR(60),
  source_report_as_of TIMESTAMPTZ,
  evidence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_occurrence_event ON system_learning_occurrences(event_id);
CREATE INDEX IF NOT EXISTS idx_occurrence_signature ON system_learning_occurrences(error_signature, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_occurrence_date ON system_learning_occurrences(event_date DESC);
CREATE INDEX IF NOT EXISTS idx_occurrence_after_protection
  ON system_learning_occurrences(after_protection) WHERE after_protection = TRUE;

-- ------------------------------------------------------------
-- PROTECTIONS
-- ------------------------------------------------------------
-- The registry of what is supposed to stop each fault coming back.
--
-- It is separate from the event so that "the protection failed" is a
-- statement about a specific named thing with a date, rather than an
-- inference from the event still being open.
CREATE TABLE IF NOT EXISTS system_protections (
  protection_id VARCHAR(120) PRIMARY KEY,
  error_signature VARCHAR(200) NOT NULL,
  protection_type VARCHAR(40) NOT NULL,
  title TEXT NOT NULL,
  rule TEXT NOT NULL,
  module VARCHAR(80),
  -- Where the protection actually lives, so a reader can go and look at it.
  implemented_in TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Effectiveness, measured rather than assumed.
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_failed_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_protection_signature ON system_protections(error_signature);
CREATE INDEX IF NOT EXISTS idx_protection_type ON system_protections(protection_type);
CREATE INDEX IF NOT EXISTS idx_protection_failed ON system_protections(failure_count) WHERE failure_count > 0;

-- ------------------------------------------------------------
-- REGRESSION CASES
-- ------------------------------------------------------------
-- A production fault turned into a standing check.
--
-- `assertion_key` names a check the engine evaluates against live audit
-- output every cycle. A regression case that nothing evaluates is a note,
-- not a test, and would report PASS forever by saying nothing.
CREATE TABLE IF NOT EXISTS system_regression_cases (
  test_id VARCHAR(120) PRIMARY KEY,
  learning_event_id BIGINT REFERENCES system_learning_events(event_id),
  test_name TEXT NOT NULL,
  category VARCHAR(60) NOT NULL,
  error_signature VARCHAR(200) NOT NULL,
  description TEXT,

  -- The evaluable part: which live assertion re-checks this fault.
  assertion_key VARCHAR(200) NOT NULL,
  input_reference TEXT,
  expected_behavior TEXT NOT NULL,
  actual_previous_behavior TEXT,
  current_behavior TEXT,

  status VARCHAR(30) NOT NULL,
  last_run_at TIMESTAMPTZ,
  pass_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_regression_signature ON system_regression_cases(error_signature);
CREATE INDEX IF NOT EXISTS idx_regression_status ON system_regression_cases(status);
CREATE INDEX IF NOT EXISTS idx_regression_assertion ON system_regression_cases(assertion_key);

-- ------------------------------------------------------------
-- AUDIT RUNS
-- ------------------------------------------------------------
-- One row per audit cycle, so a day with no findings is distinguishable
-- from a day the audit never ran. Without it, "0 errors today" is
-- ambiguous in exactly the direction that matters.
CREATE TABLE IF NOT EXISTS system_audit_runs (
  audit_run_id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  event_date DATE NOT NULL,
  report_as_of TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL,
  detectors_run INTEGER NOT NULL DEFAULT 0,
  detectors_failed INTEGER NOT NULL DEFAULT 0,
  findings INTEGER NOT NULL DEFAULT 0,
  new_errors INTEGER NOT NULL DEFAULT 0,
  recurrences INTEGER NOT NULL DEFAULT 0,
  protection_failures INTEGER NOT NULL DEFAULT 0,
  regression_failures INTEGER NOT NULL DEFAULT 0,
  source_commit VARCHAR(60),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_run_date ON system_audit_runs(event_date DESC);
CREATE INDEX IF NOT EXISTS idx_audit_run_started ON system_audit_runs(started_at DESC);
