-- ============================================================
-- SETUP LIFECYCLE — candle labels (structure engine, flag STRUCTURE)
-- ============================================================
-- Each lifecycle row carries the setup's candles, named by the structure
-- engine (structure-engine/candle-labels.ts):
--   pattern_label  human text, e.g. 'Hammer sweep of PDL → bullish engulfing'
--   patterns       { sweepPattern, displacementPattern, combo, label,
--                    scoreCandle: { rejection, engulfing, star, applied } }
-- Descriptive only: nothing reads these to decide a trade, and the score's
-- candle points never gate. NULL for WATCH rows and rows written before 028.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) — ensured at boot by
-- ensure-capture-schema.ts, like 006-027.
-- ============================================================

ALTER TABLE setup_lifecycle_events ADD COLUMN IF NOT EXISTS pattern_label TEXT;
ALTER TABLE setup_lifecycle_events ADD COLUMN IF NOT EXISTS patterns JSONB;
