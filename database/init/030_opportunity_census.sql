-- ============================================================
-- OPPORTUNITY_CENSUS (Stage 2: signal-diagnostics measurement infrastructure)
-- ============================================================
-- A post-session job classifies every objective opportunity the day offered
-- (apps/server/src/research/opportunity-census.ts: from bar t's close, price
-- reaches +2xATR15 before -1xATR15 within the session) against setup_events
-- in the same direction: TRADED / DETECTED_BUT_REJECTED / DETECTED_LATE /
-- NEVER_DETECTED. `opportunity_census_daily` is the per-instrument daily
-- summary, including CORRECTLY_EMPTY days (no opportunities that day).
--
-- Instrumentation only, read-only for every decision path. Idempotent
-- (CREATE ... IF NOT EXISTS) and ensured at boot by ensure-capture-schema.ts.
-- ============================================================

CREATE TABLE IF NOT EXISTS opportunity_census (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  session_date DATE NOT NULL,
  instrument VARCHAR(40) NOT NULL,
  exchange VARCHAR(8) NOT NULL,
  direction VARCHAR(8) NOT NULL,

  -- the opportunity window (opportunity-census.ts: bar t's close to the
  -- resolution bar, or the session end when neither leg was reached)
  window_start_bar_time TIMESTAMPTZ NOT NULL,
  window_end_bar_time TIMESTAMPTZ,
  atr15 NUMERIC,
  reached_2r BOOLEAN NOT NULL,
  reached_neg1r BOOLEAN NOT NULL,

  -- the match against setup_events, when one exists
  matched_lifecycle_id VARCHAR(120),
  matched_event_type VARCHAR(24),
  bars_to_match INTEGER, -- signed: setup_events ts vs window_start, in 15m bars

  classification VARCHAR(24) NOT NULL, -- TRADED | DETECTED_BUT_REJECTED | DETECTED_LATE | NEVER_DETECTED

  strategy_version VARCHAR(32),
  trigger_version VARCHAR(32),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (session_date, instrument, exchange, direction, window_start_bar_time)
);

CREATE INDEX IF NOT EXISTS idx_opportunity_census_session ON opportunity_census(session_date, instrument, exchange);
CREATE INDEX IF NOT EXISTS idx_opportunity_census_classification ON opportunity_census(classification, session_date DESC);

CREATE TABLE IF NOT EXISTS opportunity_census_daily (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  session_date DATE NOT NULL,
  instrument VARCHAR(40) NOT NULL,
  exchange VARCHAR(8) NOT NULL,

  opportunities INTEGER NOT NULL DEFAULT 0,
  traded INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  late INTEGER NOT NULL DEFAULT 0,
  never_detected INTEGER NOT NULL DEFAULT 0,
  capture_rate NUMERIC, -- (traded + late) / opportunities, null when opportunities = 0

  correctly_empty BOOLEAN NOT NULL DEFAULT FALSE, -- opportunities = 0 AND no setup_events that day

  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (session_date, instrument, exchange)
);

CREATE INDEX IF NOT EXISTS idx_opportunity_census_daily_instrument ON opportunity_census_daily(instrument, exchange, session_date DESC);
