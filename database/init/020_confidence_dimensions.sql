-- ============================================================
-- CONFIDENCE DIMENSIONS (Phase 1 — persistence only)
-- ============================================================
-- The ten vote contributions behind the intelligence score were computed
-- on every read and thrown away; only the weighted total survived. They
-- are persisted here individually, with four rollups:
--
--   direction_score       the chart-vote net the direction was read from
--   setup_quality_score   the pre-regime weighted intelligence score
--   tradeability_score    the option-quality score, under the spec's name
--   execution_score       PROVISIONAL: a simple spread + quote-freshness
--                         read. Phase 2 replaces it with real execution
--                         quality. The basis is stored beside it.
--
-- No threshold reads any of these. MIN_SETUP_CONFIDENCE and every other
-- gate are unchanged.
-- ============================================================

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS vote_contributions JSONB NOT NULL DEFAULT '{}';
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS direction_score DECIMAL(6,2);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS setup_quality_score INTEGER;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS tradeability_score INTEGER;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS execution_score INTEGER;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS execution_score_basis JSONB NOT NULL DEFAULT '{}';
