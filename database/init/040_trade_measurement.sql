-- ============================================================
-- 040 — Trade measurement: cost components, post-exit excursion (2026-10-09)
-- ============================================================
-- Measurement only: nothing in the decision path reads these tables.
--
-- trade_cost_records: one row per minted paper trade — the ESTIMATED cost
--   components (spread, slippage, statutory, brokerage, GST) it was sized
--   with, the total in ₹ / % of premium / R / % of planned gross profit.
--   Every figure is a model (paper fills have no actual costs); `actual` is
--   null and says so. Written once at the mint; never updated.
-- trade_post_exit: what the option and its underlying did AFTER the paper
--   exit (until the session's close), sampled from the price monitor's own
--   feed. Written once when the watch ends; never updated. The trade's
--   recorded outcome is not touched.
-- Forward-validation also stores OPTION_PAYOFF_V2 rows in the existing
--   forward_outcomes table (kind is free text), so no change is needed there.
--
-- Additive and idempotent (IF NOT EXISTS); one atomic statement each.
-- ============================================================

CREATE TABLE IF NOT EXISTS trade_cost_records (
  signal_id UUID PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  mode VARCHAR(20),
  source VARCHAR(40),
  minted_at TIMESTAMPTZ NOT NULL,
  cost_version VARCHAR(20) NOT NULL,
  -- ESTIMATED_MODEL for every record (never an actual fill).
  basis VARCHAR(30) NOT NULL,
  cost JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trade_cost_records_time ON trade_cost_records (minted_at DESC);

CREATE OR REPLACE RULE trade_cost_records_immutable AS ON UPDATE TO trade_cost_records DO INSTEAD NOTHING;

CREATE TABLE IF NOT EXISTS trade_post_exit (
  signal_id UUID PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  outcome VARCHAR(12) NOT NULL,
  close_reason VARCHAR(40),
  exit_at TIMESTAMPTZ NOT NULL,
  watched_until TIMESTAMPTZ,
  post_exit_version VARCHAR(20) NOT NULL,
  -- OBSERVED | NO_DATA | NOT_WATCHED (no session left after the exit)
  status VARCHAR(20) NOT NULL,
  record JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trade_post_exit_time ON trade_post_exit (exit_at DESC);

CREATE OR REPLACE RULE trade_post_exit_immutable AS ON UPDATE TO trade_post_exit DO INSTEAD NOTHING;
