-- ============================================================
-- STRATEGY LABELS (Phase 1 — labelling only)
-- ============================================================
-- A strategy label over readings the engine had ALREADY computed and voted
-- on (market-structure event, liquidity sweep, premium/discount zone,
-- candle pattern, positioning votes, the setup classifier's triggers). No
-- detection logic is added, and no rule reads these columns.
--
-- Taxonomy: LIQUIDITY_SWEEP | EQ_REJECTION | BOS | CHOCH |
-- TREND_CONTINUATION | VWAP_RECLAIM | BREAKOUT | MEAN_REVERSION |
-- OPTION_FLOW | OTHER
--
-- strategy_labels holds every label that qualified, in priority order.
-- primary_strategy_label is the first of them, or OTHER when none did.
-- ============================================================

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS strategy_labels JSONB NOT NULL DEFAULT '[]';
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS primary_strategy_label VARCHAR(24);

CREATE INDEX IF NOT EXISTS idx_decision_strategy_label ON decision_snapshots(primary_strategy_label, time DESC);
