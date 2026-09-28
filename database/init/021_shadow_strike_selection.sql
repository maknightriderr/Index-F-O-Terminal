-- ============================================================
-- SHADOW STRIKE SELECTION (Phase 2 — shadow only)
-- ============================================================
-- The live engine always trades the ATM strike. These columns record which
-- strike in the SAME already-fetched chain window a candidate scorer would
-- have picked instead (packages/analytics/src/strike-selection), scored by
-- the existing option-quality assessment and the existing spread ceiling.
--
-- Nothing reads these back into a decision. The live strike is recorded in
-- `strike` as before; these sit beside it for the shadow-comparison report.
-- Populated on TAKE decisions recorded from Phase 2 onward only.
-- ============================================================

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS shadow_selected_strike DECIMAL(12,2);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS shadow_selection_score INTEGER;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS shadow_selection_reason TEXT;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS shadow_rejected_alternatives JSONB NOT NULL DEFAULT '[]';
