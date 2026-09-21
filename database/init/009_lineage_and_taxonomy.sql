-- ============================================================
-- CAPTURE LINEAGE AND RESEARCH TAXONOMY
-- ============================================================
-- Observability only. No trading rule, threshold, gate or decision ordering
-- is touched by anything in this file.
--
-- Three gaps the previous release left:
--
--   A capture run recorded a single `time` and a status, which could not
--   answer "when did it start" separately from "when did it finish", could
--   not say which session it belonged to, and folded two different kinds of
--   incompleteness — the exchange not offering the strikes, and our capture
--   failing — into one `detail` string.
--
--   A refusal recorded WHY the engine said no, but not what KIND of no it
--   was. "The setup was not good enough" and "a risk control prevented
--   trading a setup that may have been fine" are different facts, and the
--   missed-winner analysis is close to meaningless without the distinction:
--   a filter that rejects bad setups and a filter that blocks good ones
--   both show up as refusals today.
--
--   Nothing recorded when each shadow layer STARTED recording, so a report
--   had to say "recording began yesterday" — relative wording that is wrong
--   the moment anybody reads it on a different day.
-- ============================================================

-- ============================================================
-- CAPTURE RUN LINEAGE
-- ============================================================
-- Start and finish are separate instants. A run that began and never
-- finished has a start, a STARTED status and a null completion — which is
-- exactly what distinguishes "died mid-flight" from "never ran".
ALTER TABLE capture_runs ADD COLUMN IF NOT EXISTS capture_started_at TIMESTAMPTZ;
ALTER TABLE capture_runs ADD COLUMN IF NOT EXISTS capture_completed_at TIMESTAMPTZ;
-- Which session this capture belongs to, as an IST trading date. Without it
-- a replay stepping session by session has to re-derive session membership
-- from a timestamp and an exchange calendar on every row.
ALTER TABLE capture_runs ADD COLUMN IF NOT EXISTS session_date DATE;
-- The underlying price the chain was centred on. "ATM" means nothing without it.
ALTER TABLE capture_runs ADD COLUMN IF NOT EXISTS spot DECIMAL(12,2);
ALTER TABLE capture_runs ADD COLUMN IF NOT EXISTS expected_strikes INTEGER;
ALTER TABLE capture_runs ADD COLUMN IF NOT EXISTS actual_strikes INTEGER;
-- Two DIFFERENT kinds of incompleteness, deliberately not merged:
--   clipping_reason  the exchange did not list the strikes we asked for.
--                    Nothing failed. The data is complete for what exists.
--   failure_reason   our capture did not store what the exchange offered.
--                    Something went wrong and the gap is ours.
-- Collapsing these would make a chain that simply lists 41 strikes
-- indistinguishable from a capture that dropped 2 legs.
ALTER TABLE capture_runs ADD COLUMN IF NOT EXISTS clipping_reason TEXT;
ALTER TABLE capture_runs ADD COLUMN IF NOT EXISTS failure_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_capture_runs_session ON capture_runs(session_date, exchange);

-- ============================================================
-- REFUSAL CLASSIFICATION
-- ============================================================
-- A research-level classification layered ON TOP of the existing reason
-- code, which is unchanged and still drives nothing. This column answers
-- one question the reason code cannot:
--
--   Did the engine reject this because the SETUP was bad, or because a
--   safety rule prevented trading a setup that might have been fine?
--
--   REFUSED                  the setup itself did not meet the bar
--   BLOCKED_BY_RISK_CONTROL  a cooldown, lock or circuit breaker intervened
--   BLOCKED_BY_DATA_QUALITY  the feed could not be read
--   NOT_ELIGIBLE             the market was closed, or no instrument existed
--
-- When missed-winner grading matures, this is what separates "our quality
-- bar costs us winners" from "our risk controls cost us winners" — two
-- findings with completely different responses.
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS refusal_class VARCHAR(28);
CREATE INDEX IF NOT EXISTS idx_decision_refusal_class ON decision_snapshots(refusal_class, time DESC);

-- The opportunity verdict, kept separate from outcome_class so the research
-- taxonomy can evolve without rewriting the grader's own column.
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS opportunity_verdict VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_decision_opportunity ON decision_snapshots(opportunity_verdict, reason_code);

-- Time to the best excursion and to the target, for the target-distance
-- research. Null when the level was never reached — never zero, which would
-- read as "reached instantly".
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS outcome_time_to_mfe_min INTEGER;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS outcome_time_to_target_min INTEGER;

-- ============================================================
-- RESEARCH MILESTONES
-- ============================================================
-- When each recorded layer first wrote a row, so no report ever has to say
-- "yesterday" again. One row per layer, written once, never updated.
CREATE TABLE IF NOT EXISTS research_milestones (
  layer VARCHAR(60) PRIMARY KEY,
  recording_started_at TIMESTAMPTZ NOT NULL,
  note TEXT
);
