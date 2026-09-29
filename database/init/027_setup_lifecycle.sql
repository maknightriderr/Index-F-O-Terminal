-- ============================================================
-- SETUP LIFECYCLE EVENTS (structure engine, flag STRUCTURE)
-- ============================================================
-- One row per lifecycle transition of a structure setup: WATCH (price near
-- an untaken liquidity pool), DEVELOPING (the pool was swept), CONFIRMED
-- (displacement printed; zone, stop and T1 defined; the limit rests),
-- ENTRY / ACTIVE / CLOSED, and the endings INVALIDATED, LATE, MISSED,
-- LOW_RR — plus ENTRY_MINTED / ENTRY_REFUSED for what the live engine did at
-- the fill.
--
-- Deliberately NOT the `signals` table: a lifecycle stage is not a trade.
-- Only a filled limit mints a paper trade (a `signals` row and a TAKE
-- decision), and decision_id / signal_id link that transition to them.
--
-- Idempotent (CREATE ... IF NOT EXISTS) — ensured at boot by
-- ensure-capture-schema.ts, like 006-026.
-- ============================================================

CREATE TABLE IF NOT EXISTS setup_lifecycle_events (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  -- When the transition happened (the closing bar that caused it, or the live fill).
  time TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lifecycle_id VARCHAR(120) NOT NULL,
  symbol VARCHAR(40) NOT NULL,
  exchange VARCHAR(8) NOT NULL,
  mode VARCHAR(16) NOT NULL,
  direction VARCHAR(8) NOT NULL,
  from_state VARCHAR(24),
  to_state VARCHAR(24) NOT NULL,
  reason TEXT,
  pool_kind VARCHAR(32),
  pool_price NUMERIC,
  zone_kind VARCHAR(12),
  zone_near NUMERIC,
  zone_far NUMERIC,
  entry NUMERIC,
  stop NUMERIC,
  t1 NUMERIC,
  t2 NUMERIC,
  score INTEGER,
  underlying_price NUMERIC,
  decision_id UUID,
  signal_id UUID,
  logic_version VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_events_lifecycle ON setup_lifecycle_events(lifecycle_id, time);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_symbol_time ON setup_lifecycle_events(symbol, time DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_state ON setup_lifecycle_events(to_state, time DESC);
