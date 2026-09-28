-- ============================================================
-- SIGNAL FRESHNESS (Phase 1 — measurement only)
-- ============================================================
-- How old the inputs behind a decision were at the instant it was made,
-- how long the setup is considered valid for, and whether a sticky setup
-- that was later re-surfaced had gone stale against the live underlying.
--
-- NOTHING HERE GATES A DECISION. A stale sticky setup is flagged and a
-- SIGNAL_STALE row is written to gate_diagnostics, but the live setup is
-- left exactly as it was: forcing an invalidation is Phase 2, and only once
-- this data shows it would have helped.
--
-- The per-input timestamps are the finest-grained source timestamps the
-- feed carries today. The option chain stamps itself once (spot, PCR) and
-- each leg stamps itself once (quote, OI, IV, Greeks, volume), so several
-- of these columns will carry the same instant. They are kept separate so
-- a future feed that stamps each input independently needs no migration.
-- ============================================================

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS signal_age_seconds DECIMAL(12,2);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS underlying_quote_timestamp TIMESTAMPTZ;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS option_quote_timestamp TIMESTAMPTZ;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS oi_timestamp TIMESTAMPTZ;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS pcr_timestamp TIMESTAMPTZ;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS iv_timestamp TIMESTAMPTZ;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS greeks_timestamp TIMESTAMPTZ;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS volume_timestamp TIMESTAMPTZ;

-- The underlying price the setup was minted against. Staleness on a later
-- poll is measured as the move away from this, in ATR.
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS underlying_price_at_generation DECIMAL(12,2);

-- Filled in only when a sticky setup is re-surfaced after the underlying
-- moved beyond SIGNAL_STALENESS_MOVE_ATR. Written once, never cleared.
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS stale BOOLEAN;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS stale_flagged_at TIMESTAMPTZ;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS stale_move_atr DECIMAL(8,4);

CREATE INDEX IF NOT EXISTS idx_decision_stale ON decision_snapshots(stale, time DESC);
