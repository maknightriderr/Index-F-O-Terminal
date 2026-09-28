-- ============================================================
-- EXECUTION QUALITY SHADOW (Phase 2 — shadow only)
-- ============================================================
-- Paper trading only: nothing is filled. The live paper entry is the bid-ask
-- mid (recorded in `premium`). These columns record the same paper trade
-- entered at the ASK, against the same live stop and target
-- (packages/analytics/src/execution-quality).
--
--   shadow_entry_price        ask when a two-sided quote exists, else LTP
--   shadow_execution_quality  NORMAL, or DEGRADED when no reliable bid/ask
--                             existed and the entry fell back to LTP
--   shadow_net_r              net R at the shadow entry (live cost model)
--   live_net_r                net R at the live mid entry, recomputed by the
--                             same formula, so the two compare like for like
--
-- The Phase 1 execution_score (provisional) is left as it is. Nothing reads
-- these back into a decision. Populated on TAKE decisions from Phase 2 on.
-- ============================================================

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS shadow_entry_price DECIMAL(12,2);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS shadow_execution_quality VARCHAR(10)
  CHECK (shadow_execution_quality IN ('NORMAL', 'DEGRADED'));
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS shadow_net_r DECIMAL(8,4);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS live_net_r DECIMAL(8,4);
