-- ============================================================
-- SETUP_EVENTS (Stage 2: signal-diagnostics measurement infrastructure)
-- ============================================================
-- One row per detected setup and per lifecycle transition that matters:
-- WATCH, SWEEP_DETECTED, SETUP_CREATED / CONFIRMED, REJECTED (with reason),
-- INVALIDATED, LOW_RR, LATE, MISSED, TRADED, CLOSED.
--
-- Deliberately separate from `signals` (a lifecycle stage is not a trade)
-- and from `setup_lifecycle_events` (migrations 027/028), which nothing
-- reads today — this table is the one the diagnostics API/dashboard reads.
-- It is written from the structure lifecycle (setup-lifecycle.ts) and from
-- the structure mint path's refusal (market-bias.ts resolveStructureSetup).
--
-- Grades are descriptive bands (A+/A/B/C) fixed in advance from the score's
-- own component structure, before any outcome was looked at — see
-- apps/server/src/services/setup-events.ts `gradeFromScore`.
--
-- Instrumentation only: nothing in the decision path reads this table, and a
-- write failure here must never block or alter a trading decision (see
-- setup-events.ts — every insert is try/caught and logged, never silently
-- swallowed).
--
-- Idempotent (CREATE ... IF NOT EXISTS) and ensured at boot by
-- ensure-capture-schema.ts, like 006-028.
-- ============================================================

CREATE TABLE IF NOT EXISTS setup_events (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  time TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  instrument VARCHAR(40) NOT NULL,
  exchange VARCHAR(8) NOT NULL,
  timeframe VARCHAR(8) NOT NULL,
  lifecycle_id VARCHAR(120) NOT NULL,
  direction VARCHAR(8) NOT NULL,
  event_type VARCHAR(24) NOT NULL, -- WATCH | SWEEP_DETECTED | SETUP_CREATED | CONFIRMED | REJECTED | INVALIDATED | LOW_RR | LATE | MISSED | TRADED | CLOSED

  -- pool
  pool_id VARCHAR(160),
  pool_type VARCHAR(32),
  pool_price NUMERIC,

  -- trigger / sweep
  trigger_type VARCHAR(32),
  sweep_high NUMERIC,
  sweep_low NUMERIC,
  sweep_depth NUMERIC,

  -- trade geometry
  entry NUMERIC,
  stop NUMERIC,
  t1 NUMERIC,
  t2 NUMERIC,
  gross_rr NUMERIC,

  -- cost-in-R (nullable for now: no real option-cost model is built in this round)
  cost_components JSONB,
  net_rr NUMERIC,

  -- score components (separate columns; total and grade are descriptive, fixed in advance)
  score_pool NUMERIC,
  score_sweep NUMERIC,
  score_displacement NUMERIC,
  score_candle NUMERIC,
  score_rr NUMERIC,
  score_option NUMERIC,
  score_total NUMERIC,
  grade VARCHAR(4),

  -- context (session phase, 1H trend, volatility, VWAP side, OI, ...)
  context JSONB,
  -- the option leg this setup would have used, when known
  option_candidate JSONB,

  -- decision
  decision VARCHAR(16), -- e.g. WATCH | DETECTED | REJECTED | TRADED
  rejection_reason TEXT,
  would_be_valid_if TEXT,

  -- outcome (filled in by the grading job, once the session has ended)
  result_r NUMERIC,
  mfe_r NUMERIC,
  mae_r NUMERIC,
  exit_reason VARCHAR(24),
  graded_at TIMESTAMPTZ,

  -- versioning (Stage 2: LogicStampExtras.versions)
  strategy_version VARCHAR(32),
  trigger_version VARCHAR(32),
  risk_version VARCHAR(32),
  option_version VARCHAR(32),
  cost_version VARCHAR(32)
);

CREATE INDEX IF NOT EXISTS idx_setup_events_lifecycle ON setup_events(lifecycle_id, time);
CREATE INDEX IF NOT EXISTS idx_setup_events_instrument_time ON setup_events(instrument, exchange, time DESC);
CREATE INDEX IF NOT EXISTS idx_setup_events_type_time ON setup_events(event_type, time DESC);
CREATE INDEX IF NOT EXISTS idx_setup_events_ungraded ON setup_events(time) WHERE graded_at IS NULL AND event_type IN ('TRADED', 'REJECTED', 'LOW_RR', 'LATE');
