-- ============================================================
-- EXIT REASON + DEAD-TRADE ANALYTICS (Phase 1 — analytics only)
-- ============================================================
-- Everything here describes SIMULATED outcomes. This is a paper-trading
-- system: nothing records a real order, a real fill or real account P&L.
--
-- exit_reason
--   How the missed-winner audit's underlying-thesis replay resolved:
--   TARGET or STOP when a level was reached, TIME_EXIT when the grading
--   horizon ran out first. Written by gradeDecision() from the same
--   hit_target/hit_stop truth it already wrote — made explicit, not new.
--
-- dead_at / mfe_at_dead / mae_at_dead
--   The first instant trade-health's existing DEAD rule (no 0.25 ATR of
--   favourable progress by 30 minutes) fired for a TAKEN setup, and the
--   underlying excursion in ATR at that instant. Trade health still only
--   reports: nothing here closes a position.
--
-- eventual_exit_reason / eventual_r / eventual_close_reason
--   How that simulated position actually closed, backfilled when it did,
--   so a report can ask "of the trades flagged dead, how many recovered?".
--   eventual_r is the same gross premium R the close notifier already
--   reports (return % over initial-stop risk %), not a third formula.
-- ============================================================

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS exit_reason VARCHAR(20)
  CHECK (exit_reason IN ('TARGET', 'STOP', 'TIME_EXIT', 'EXPIRY', 'INVALIDATED', 'MANUAL_TEST_EXIT', 'OTHER'));

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS dead_at TIMESTAMPTZ;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS mfe_at_dead DECIMAL(8,4);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS mae_at_dead DECIMAL(8,4);

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS eventual_exit_reason VARCHAR(20)
  CHECK (eventual_exit_reason IN ('TARGET', 'STOP', 'TIME_EXIT', 'EXPIRY', 'INVALIDATED', 'MANUAL_TEST_EXIT', 'OTHER'));
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS eventual_r DECIMAL(8,4);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS eventual_close_reason VARCHAR(24);

CREATE INDEX IF NOT EXISTS idx_decision_exit_reason ON decision_snapshots(exit_reason, time DESC);
CREATE INDEX IF NOT EXISTS idx_decision_dead ON decision_snapshots(dead_at) WHERE dead_at IS NOT NULL;
