-- ============================================================
-- 035 — Option plans and their evolution (Phase 3, 2026-10-05)
-- ============================================================
-- option_plans: the option plan of every minted paper trade, persisted with
--   its underlying plan — underlying entry / SL / T1 / T2, the option leg
--   (side / strike / expiry / token) and its premium Entry / SL / TSL / T1 /
--   T2, the selected strike, and EVERY strike the OptionCandidate pipeline
--   evaluated (selected, ranked or rejected with the stage and reason).
--   Immutable (rule below): what was planned at the mint never changes.
-- option_plan_events: each later change of the option levels (CREATED at the
--   mint, TSL_MOVED when the trailing stop ratchets, CLOSED with the exit)
--   as an insert-only row — the plan's evolution.
-- signal_id / snapshot_id are logical references (the writers are
-- fire-and-forget; a plan write must never fail a mint).
--
-- Additive and idempotent: IF NOT EXISTS / OR REPLACE only, nothing existing
-- is altered or deleted; one atomic DDL statement each (the boot runner
-- applies them one by one).
-- ============================================================

CREATE TABLE IF NOT EXISTS option_plans (
  plan_id UUID PRIMARY KEY,
  signal_id UUID,
  snapshot_id UUID,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  mode VARCHAR(20) NOT NULL,
  -- S1 / INDICATOR / MOMENTUM_BREAK / a trigger id.
  source VARCHAR(40) NOT NULL,
  candidate_id VARCHAR(160),
  direction VARCHAR(10) NOT NULL,
  underlying_entry NUMERIC,
  underlying_stop NUMERIC,
  underlying_t1 NUMERIC,
  underlying_t2 NUMERIC,
  option_side VARCHAR(2),
  option_strike NUMERIC,
  option_expiry VARCHAR(20),
  option_token VARCHAR(40),
  option_entry NUMERIC,
  option_sl NUMERIC,
  option_tsl NUMERIC,
  option_t1 NUMERIC,
  option_t2 NUMERIC,
  selected_strike NUMERIC,
  -- Every OptionCandidate (selected / ranked / rejected + stage + reason), best first.
  candidates JSONB NOT NULL,
  -- The rejected ones only, for direct querying.
  rejected_strikes JSONB NOT NULL,
  option_selection_version VARCHAR(40) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_option_plans_signal ON option_plans (signal_id) WHERE signal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_option_plans_snapshot ON option_plans (snapshot_id) WHERE snapshot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_option_plans_symbol_time ON option_plans (symbol, created_at DESC);

-- Immutable: an UPDATE of a plan does nothing (changes are option_plan_events rows).
CREATE OR REPLACE RULE option_plans_immutable AS ON UPDATE TO option_plans DO INSTEAD NOTHING;

CREATE TABLE IF NOT EXISTS option_plan_events (
  event_id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES option_plans (plan_id),
  at TIMESTAMPTZ NOT NULL,
  -- CREATED | TSL_MOVED | CLOSED
  event_type VARCHAR(20) NOT NULL,
  -- The option levels before and after the change (entry, sl, tsl, t1, t2).
  levels_before JSONB,
  levels_after JSONB NOT NULL,
  reason TEXT,
  snapshot_id UUID,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_option_plan_events_plan ON option_plan_events (plan_id, at);

-- Insert-only.
CREATE OR REPLACE RULE option_plan_events_immutable AS ON UPDATE TO option_plan_events DO INSTEAD NOTHING;
