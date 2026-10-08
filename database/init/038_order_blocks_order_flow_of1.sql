-- ============================================================
-- 038 — Order Block shadow (OB-2.0), Order Flow bars, OF1 candidates (2026-10-09)
-- ============================================================
-- Measurement only: nothing in the decision path reads these tables.
-- order_blocks:        every OB-2.0 block with its lifecycle (FRESH →
--                      FIRST_TOUCH → MITIGATED) and reaction (MFE / MAE in
--                      ATR), recomputed deterministically from closed bars.
-- order_block_shadow:  per decision bar, the legacy (live) OB vote beside the
--                      OB-2.0 signal, and whether the OB-2.0 vote would have
--                      changed the indicator engine's direction.
-- order_flow_bars:     per 15m bar, the footprint from the Dhan feed with its
--                      delta_mode (EXACT / INFERRED / UNAVAILABLE); measures it
--                      cannot compute are NULL, never zero.
-- of1_candidates:      every OF1 candidate (shadow), its option plan, whether it
--                      would trade if live, the candidate that actually won
--                      the slot, and its hypothetical graded outcome.
-- Additive and idempotent; one atomic statement each.
-- ============================================================

CREATE TABLE IF NOT EXISTS order_blocks (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  version VARCHAR(20) NOT NULL,
  block_type VARCHAR(10) NOT NULL,
  block_time TIMESTAMPTZ NOT NULL,
  displacement_time TIMESTAMPTZ NOT NULL,
  block_high NUMERIC NOT NULL,
  block_low NUMERIC NOT NULL,
  atr NUMERIC NOT NULL,
  displacement_atr NUMERIC NOT NULL,
  -- FRESH | FIRST_TOUCH | MITIGATED
  state VARCHAR(20) NOT NULL,
  first_touch_time TIMESTAMPTZ,
  mitigated_time TIMESTAMPTZ,
  reaction_bars INTEGER,
  mfe_atr NUMERIC,
  mae_atr NUMERIC,
  -- TRUE: ≥ 1 ATR in its direction before failing; FALSE: failed / no reaction; NULL: undecided
  held BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, exchange, version, block_time, block_type)
);

CREATE INDEX IF NOT EXISTS idx_order_blocks_symbol_time ON order_blocks (symbol, block_time DESC);

CREATE TABLE IF NOT EXISTS order_block_shadow (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  mode VARCHAR(20) NOT NULL,
  decision_bar_time TIMESTAMPTZ NOT NULL,
  version VARCHAR(20) NOT NULL,
  -- The vote the live indicator used (legacy OB-1.0): -1, 0, 1
  legacy_vote SMALLINT NOT NULL,
  -- The OB-2.0 signal at the same closed bar: -1, 0, 1
  v2_vote SMALLINT NOT NULL,
  block_type VARCHAR(10),
  block_time TIMESTAMPTZ,
  block_high NUMERIC,
  block_low NUMERIC,
  live_direction VARCHAR(10) NOT NULL,
  direction_with_v2 VARCHAR(10) NOT NULL,
  changed_direction BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, exchange, mode, decision_bar_time)
);

CREATE INDEX IF NOT EXISTS idx_order_block_shadow_time ON order_block_shadow (decision_bar_time DESC);

CREATE TABLE IF NOT EXISTS order_flow_bars (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  -- The traded instrument the flow was read from (e.g. the nearest index future) and its source.
  instrument VARCHAR(80),
  source VARCHAR(20) NOT NULL,
  bar_time TIMESTAMPTZ NOT NULL,
  bar_ms INTEGER NOT NULL,
  -- EXACT | INFERRED | UNAVAILABLE
  delta_mode VARCHAR(12) NOT NULL,
  -- Why a bar is UNAVAILABLE (feed down, no trades, …)
  unavailable_reason VARCHAR(80),
  trades INTEGER NOT NULL DEFAULT 0,
  volume NUMERIC,
  buy_volume NUMERIC,
  sell_volume NUMERIC,
  unclassified_volume NUMERIC,
  delta NUMERIC,
  delta_pct NUMERIC,
  poc NUMERIC,
  vah NUMERIC,
  val NUMERIC,
  buy_imbalances INTEGER,
  sell_imbalances INTEGER,
  levels JSONB,
  version VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, exchange, bar_time)
);

CREATE INDEX IF NOT EXISTS idx_order_flow_bars_symbol_time ON order_flow_bars (symbol, bar_time DESC);

CREATE TABLE IF NOT EXISTS of1_candidates (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  mode VARCHAR(20) NOT NULL,
  decision_bar_time TIMESTAMPTZ NOT NULL,
  direction VARCHAR(10) NOT NULL,
  strategy_version VARCHAR(20) NOT NULL,
  subtype VARCHAR(60) NOT NULL,
  location_kind VARCHAR(20) NOT NULL,
  location_price NUMERIC NOT NULL,
  atr NUMERIC NOT NULL,
  entry NUMERIC NOT NULL,
  stop NUMERIC NOT NULL,
  target NUMERIC,
  target_kind VARCHAR(20),
  expected_move NUMERIC,
  delta_mode VARCHAR(12) NOT NULL,
  delta NUMERIC,
  delta_pct NUMERIC,
  poc NUMERIC,
  vah NUMERIC,
  val NUMERIC,
  imbalances INTEGER,
  absorption BOOLEAN,
  evidence JSONB NOT NULL,
  price_confirmation TEXT,
  option_plan JSONB,
  cost_pct NUMERIC,
  would_trade_if_live BOOLEAN NOT NULL,
  would_not_trade_reason TEXT,
  -- Filled after the session by the forward-validation pass:
  existing_candidate_that_won VARCHAR(200),
  existing_source_that_won VARCHAR(40),
  outcome VARCHAR(20),
  outcome_r NUMERIC,
  mfe_r NUMERIC,
  mae_r NUMERIC,
  graded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, exchange, mode, decision_bar_time, direction)
);

CREATE INDEX IF NOT EXISTS idx_of1_candidates_time ON of1_candidates (decision_bar_time DESC);
