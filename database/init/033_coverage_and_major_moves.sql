-- ============================================================
-- DATA COVERAGE + MAJOR-MOVE DIAGNOSTICS (measurement only)
-- ============================================================
-- recorder_boots: one row per backend boot. A boot inside a session marks a
-- recording gap (the previous process stopped around then), so the census
-- can tell a data problem from a signal failure
-- (packages/analytics/src/event-engine/data-quality.ts).
--
-- opportunity_census_daily gains the session's coverage: COVERED / PARTIAL /
-- UNCOVERED / DATA_GAP, the bar counts behind it, the recording window, and
-- how many opportunities fell in a gap (classified DATA_GAP, never
-- NEVER_DETECTED, and left out of the rate denominators).
--
-- major_move_diagnostics: one row per instrument-session whose largest
-- directional leg was ≥ 1 average session range — what started it, which
-- research trigger families recognised it, the first actionable point, how
-- much of the move was left, whether the live engine traded it, and why not.
-- The research triggers run here post-session only (RESEARCH status): they
-- never feed a live decision.
--
-- Idempotent; ensured at boot.
-- ============================================================

CREATE TABLE IF NOT EXISTS recorder_boots (
  id BIGSERIAL PRIMARY KEY,
  boot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  logic_version VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_recorder_boots_at ON recorder_boots(boot_at);
-- The two boots before this table existed (the PR #12 and PR #13 deploys, from the Railway logs).
INSERT INTO recorder_boots (boot_at, logic_version)
SELECT t, 'seeded' FROM (VALUES (TIMESTAMPTZ '2026-09-30T13:22:38Z'), (TIMESTAMPTZ '2026-09-30T14:46:54Z')) AS v(t)
WHERE NOT EXISTS (SELECT 1 FROM recorder_boots b WHERE b.boot_at = v.t);

ALTER TABLE opportunity_census_daily ADD COLUMN IF NOT EXISTS coverage VARCHAR(12);
ALTER TABLE opportunity_census_daily ADD COLUMN IF NOT EXISTS session_start TIMESTAMPTZ;
ALTER TABLE opportunity_census_daily ADD COLUMN IF NOT EXISTS session_end TIMESTAMPTZ;
ALTER TABLE opportunity_census_daily ADD COLUMN IF NOT EXISTS recording_start TIMESTAMPTZ;
ALTER TABLE opportunity_census_daily ADD COLUMN IF NOT EXISTS recording_end TIMESTAMPTZ;
ALTER TABLE opportunity_census_daily ADD COLUMN IF NOT EXISTS expected_bars INTEGER;
ALTER TABLE opportunity_census_daily ADD COLUMN IF NOT EXISTS present_bars INTEGER;
ALTER TABLE opportunity_census_daily ADD COLUMN IF NOT EXISTS missing_bars INTEGER;
ALTER TABLE opportunity_census_daily ADD COLUMN IF NOT EXISTS stale_bars INTEGER;
ALTER TABLE opportunity_census_daily ADD COLUMN IF NOT EXISTS data_gap INTEGER;
ALTER TABLE opportunity_census_daily ADD COLUMN IF NOT EXISTS option_data_status VARCHAR(64);

CREATE TABLE IF NOT EXISTS major_move_diagnostics (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  session_date DATE NOT NULL,
  instrument VARCHAR(40) NOT NULL,
  exchange VARCHAR(8) NOT NULL,
  direction VARCHAR(8) NOT NULL,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  start_price NUMERIC,
  end_price NUMERIC,
  size_adr NUMERIC,
  classification VARCHAR(32) NOT NULL,
  coverage VARCHAR(12),
  first_event_type VARCHAR(32),
  first_event_time TIMESTAMPTZ,
  families_recognized JSONB,
  first_actionable JSONB,
  traded BOOLEAN,
  reason TEXT,
  engine_version VARCHAR(32),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_date, instrument, exchange, direction)
);
CREATE INDEX IF NOT EXISTS idx_major_move_session ON major_move_diagnostics(session_date DESC, instrument);
