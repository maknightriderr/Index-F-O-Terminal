-- ============================================================
-- EXPOSURE, DTE BUCKET, INVALIDATION REASON (Phase 2 — live, observational)
-- ============================================================
-- Three labels. None of them gates, blocks, filters or alters a setup.
--
-- EXPOSURE (simulated portfolio accounting only — not broker positions)
--   Written when a new paper setup is minted, from the other sticky setups
--   live in Redis at that moment (apps/server/src/services/exposure-tracker).
--   open_simulated_risk       rupees at risk to the stops across all live
--                             paper setups including this one
--   open_setup_count          live paper setups including this one
--   same_symbol_exposure      OTHER live setups holding the same contract
--   same_underlying_exposure  OTHER live setups on the same underlying
--   same_direction_exposure   OTHER live setups in the same direction
--   correlated_exposure       OTHER live setups in the same direction on a
--                             DIFFERENT symbol of the same configured index
--                             family (e.g. NIFTY + BANKNIFTY both bullish)
--   exposure_detail           risk per category and the family used
--
-- DTE BUCKET
--   0DTE / 1-3DTE / 4-7DTE / 8-30DTE / 30+DTE, from the shared helper
--   (@fno/shared classifyDteBucket). A label on the already-recorded dte.
--
-- INVALIDATION REASON
--   Which of the two existing, already-separate close branches fired for a
--   taken paper trade: the option-premium stop/target check (evaluated first,
--   unconditionally) or the underlying bias-reversal branch. Labelling only:
--   no condition was added. NULL for closes that are neither (session end,
--   self-heal of an implausible setup).
-- ============================================================

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS open_simulated_risk DECIMAL(14,2);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS open_setup_count INTEGER;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS same_symbol_exposure INTEGER;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS same_underlying_exposure INTEGER;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS same_direction_exposure INTEGER;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS correlated_exposure INTEGER;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS exposure_detail JSONB NOT NULL DEFAULT '{}';

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS dte_bucket VARCHAR(8)
  CHECK (dte_bucket IN ('0DTE', '1-3DTE', '4-7DTE', '8-30DTE', '30+DTE'));

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS invalidation_reason VARCHAR(40)
  CHECK (invalidation_reason IN ('OPTION_EMERGENCY_STOP', 'OPTION_TARGET_HIT', 'UNDERLYING_STRUCTURAL_INVALIDATION'));

CREATE INDEX IF NOT EXISTS idx_decision_dte_bucket ON decision_snapshots(dte_bucket, time DESC);
CREATE INDEX IF NOT EXISTS idx_decision_invalidation ON decision_snapshots(invalidation_reason) WHERE invalidation_reason IS NOT NULL;
