-- ============================================================
-- CAPTURE INSTRUMENTATION
-- ============================================================
-- Observability only. Nothing in this file changes a trading rule, a
-- threshold, a gate or the order decisions are made in.
--
-- It exists because the first capture release could not answer questions
-- that turned out to matter immediately:
--
--   "656 option legs" is not a multiple of the 86 a complete chain
--   snapshot should produce, and there was no way to tell whether that
--   meant partial chains, failed passes, or a miscount — because nothing
--   recorded that a capture had been ATTEMPTED, only what it managed to
--   write. A pass that silently wrote 40 legs instead of 86 was
--   indistinguishable from one that never ran.
--
--   A refusal could not be told apart from a refusal that had matured
--   enough to grade, other than by recomputing the horizon in the
--   reporting query and hoping it matched the one the audit uses.
--
--   Which setup the engine had actually detected was nowhere on the
--   decision record, so setup-specific expectancy could never be computed
--   no matter how many observations accumulated.
-- ============================================================

-- ============================================================
-- CAPTURE RUNS
-- ============================================================
-- One row per attempted symbol capture, written whether it succeeds,
-- partially succeeds or fails. This is what makes a missing capture
-- visible instead of merely absent: an interval with no capture_runs row
-- is a pass that never ran, and an interval with a row whose actual_legs
-- is below expected_legs is a chain that came back short.
--
-- Deliberately records the ATTEMPT before the outcome is known, so a
-- capture that throws still leaves a trace.
-- ============================================================
CREATE TABLE IF NOT EXISTS capture_runs (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  time TIMESTAMPTZ NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  symbol VARCHAR(50) NOT NULL,
  expiry DATE,
  -- ATTEMPT is written first and updated in place; a row still reading
  -- ATTEMPT after the service moved on is a capture that died mid-flight.
  status VARCHAR(16) NOT NULL,        -- ATTEMPT | SUCCESS | PARTIAL | FAILED
  -- What a complete chain snapshot should have produced for this symbol,
  -- given the strike window and how many strikes the chain actually listed.
  strikes_available INTEGER,
  strikes_captured INTEGER,
  expected_legs INTEGER,
  actual_legs INTEGER,
  futures_rows INTEGER,
  positioning_rows INTEGER,
  underlying_rows INTEGER,
  duration_ms INTEGER,
  -- Why legs are missing, when they are. Never inferred later.
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_capture_runs_time ON capture_runs(time DESC);
CREATE INDEX IF NOT EXISTS idx_capture_runs_symbol ON capture_runs(symbol, time DESC);
CREATE INDEX IF NOT EXISTS idx_capture_runs_status ON capture_runs(status, time DESC);

-- ============================================================
-- DECISION SNAPSHOT: SETUP IDENTITY AND SESSION POSITION
-- ============================================================
-- Every column here describes what the engine ALREADY detected at the
-- moment it decided. None of them is read by any rule; adding them cannot
-- change a decision, and a test asserts that.
-- ============================================================

-- What the engine saw, named. UNKNOWN when nothing classifiable was
-- detected — never a guess, because a fabricated setup label would poison
-- setup-specific expectancy far more quietly than a missing one.
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS setup_type VARCHAR(40);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS setup_family VARCHAR(40);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS primary_trigger VARCHAR(40);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS setup_timeframe VARCHAR(16);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS setup_detail JSONB NOT NULL DEFAULT '{}';

-- Position within the session, computed from the exchange session calendar
-- at decision time and then immutable. Needed to investigate whether early
-- session behaviour differs — an open question the opening-hour guard was
-- built on and which has never been measured forward.
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS minutes_from_session_open INTEGER;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS session_bucket VARCHAR(12);

-- Target and stop distance in ATR as scalar columns. Already present inside
-- the risk JSONB; promoted here so the target-distance analysis can group on
-- them without parsing JSON per row.
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS target_atr DECIMAL(8,4);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS stop_atr DECIMAL(8,4);

-- Shadow readings alongside the live decision, for the agreement table.
-- shadow_would_refuse is what the not-yet-live layers TOGETHER would have
-- said. It is recorded, compared and reported; it is never consulted.
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS shadow_would_refuse BOOLEAN;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS shadow_refuse_reasons VARCHAR(200);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS shadow_agrees_with_live BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_decision_setup ON decision_snapshots(setup_family, time DESC);
CREATE INDEX IF NOT EXISTS idx_decision_session_bucket ON decision_snapshots(session_bucket, time DESC);

-- ============================================================
-- STOP EVENTS
-- ============================================================
-- Full state at the instant a stop fires.
--
-- Of the 17 recorded stops, 6 could not be classified at all and 3 more
-- only by reconstructing excursions from candles fetched weeks later. The
-- reconstruction is why those six are permanently unknown: the chain state
-- that would have settled them was never stored and cannot be recovered.
--
-- This table ends that for future stops. It does NOT rewrite the six —
-- historical unknowns stay unknown, because inventing a classification for
-- them would be worse than admitting the gap.
-- ============================================================
CREATE TABLE IF NOT EXISTS stop_events (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  time TIMESTAMPTZ NOT NULL,
  setup_id VARCHAR(80),
  decision_id UUID,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  mode VARCHAR(20),
  direction VARCHAR(20),

  -- Prices at the moment the stop fired
  underlying_price DECIMAL(12,2),
  underlying_at_entry DECIMAL(12,2),
  option_price DECIMAL(12,2),
  entry_price DECIMAL(12,2),
  stop_price DECIMAL(12,2),
  target_price DECIMAL(12,2),

  -- The scale the thesis was sized on, and the level that would have
  -- invalidated it. Without these the "was the thesis wrong, or was it the
  -- option" question cannot be answered at all.
  atr DECIMAL(12,4),
  underlying_invalidation_level DECIMAL(12,2),
  stop_in_atr DECIMAL(8,4),
  target_in_atr DECIMAL(8,4),

  -- Excursions as folded forward by the monitor, not reconstructed
  mfe DECIMAL(12,4),
  mae DECIMAL(12,4),
  mfe_atr DECIMAL(8,4),
  mae_atr DECIMAL(8,4),
  hold_minutes INTEGER,

  -- The instrument's own state, which is what separates a decay stop from
  -- a thesis stop
  iv DECIMAL(8,4),
  iv_at_entry DECIMAL(8,4),
  delta DECIMAL(8,6),
  theta DECIMAL(10,4),
  bid DECIMAL(12,2),
  ask DECIMAL(12,2),
  spread_pct DECIMAL(8,4),
  oi BIGINT,
  volume BIGINT,

  market_regime VARCHAR(40),
  setup_type VARCHAR(40),
  trade_health VARCHAR(20),

  -- Classified at fire time from the state above, never reconstructed later
  classification VARCHAR(32),   -- THESIS_INVALIDATION | OPTION_DECAY | IV_EFFECT | LIQUIDITY_SWEEP | EXECUTION | NORMAL_VOLATILITY | UNKNOWN
  classification_basis TEXT,
  context JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_stop_events_time ON stop_events(time DESC);
CREATE INDEX IF NOT EXISTS idx_stop_events_symbol ON stop_events(symbol, time DESC);
CREATE INDEX IF NOT EXISTS idx_stop_events_class ON stop_events(classification, time DESC);
