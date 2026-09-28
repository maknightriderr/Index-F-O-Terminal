-- ============================================================
-- TARGET ESTIMATE v2 SHADOW (Phase 2 — shadow only)
-- ============================================================
-- The live target is delta x expected move (first order). These columns
-- record a second-order estimate that adds the gamma term and subtracts
-- theta decay over the expected hold (packages/analytics/src/target-estimate),
-- beside the live `target`, which is unchanged.
--
--   shadow_target_v2          entry + deltaMove + 0.5*|gamma|*move^2 - theta decay
--   shadow_expected_net_r_v2  net R to that target at the live entry and stop
--   shadow_target_detail      the terms, for audit
--
-- Nothing reads these back into a decision. Populated on TAKE decisions from
-- Phase 2 onward.
-- ============================================================

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS shadow_target_v2 DECIMAL(12,2);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS shadow_expected_net_r_v2 DECIMAL(8,4);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS shadow_target_detail JSONB NOT NULL DEFAULT '{}';
