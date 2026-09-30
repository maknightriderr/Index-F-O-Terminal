-- ============================================================
-- SETUP_EVENTS: per-setup option cost, stop distance, fill status
-- ============================================================
-- Measurement only (apps/server/src/services/setup-cost.ts). Nothing in the
-- decision path reads these columns; option cost is not a gate.
--
-- Cost parts are ₹ per option unit and in R (the same unit as gross_rr:
-- underlying T1 distance ÷ underlying stop, with the cost converted to
-- underlying points through the leg's |delta|). cost_components (029) keeps
-- the full measurement, including which parts were OBSERVED from the live
-- quote and which were MODELLED from TRADING_COST_MODEL.
--
-- cost_quality: OBSERVED (two-sided live quote) | MODELLED (spread assumed) |
-- UNAVAILABLE (no option quote at that transition).
--
-- fill_status / net_result_r are set by the post-session grading job:
-- FILLED when price traded at the entry after the event, NO_FILL otherwise;
-- net_result_r = result_r − cost_r, only for FILLED rows with a cost in R.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); ensured at boot.
-- ============================================================

ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS cost_quality VARCHAR(12);
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS option_side VARCHAR(2);
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS option_strike NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS option_expiry VARCHAR(10);
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS option_strike_basis VARCHAR(12);
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS option_premium NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS option_bid NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS option_ask NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS option_delta NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS lot_size INTEGER;

ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS cost_spread NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS cost_slippage NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS cost_charges NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS cost_total NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS cost_pct_premium NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS cost_r NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS spread_r NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS slippage_r NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS charges_r NUMERIC;

ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS stop_points NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS stop_atr NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS stop_pct NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS underlying_risk_lot NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS option_risk_unit NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS option_risk_lot NUMERIC;
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS option_risk_basis VARCHAR(16);

ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS fill_status VARCHAR(8);
ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS net_result_r NUMERIC;

CREATE INDEX IF NOT EXISTS idx_setup_events_strategy_version ON setup_events(strategy_version, time DESC);
