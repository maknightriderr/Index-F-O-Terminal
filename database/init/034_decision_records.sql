-- ============================================================
-- 034 — Immutable input snapshots and DecisionRecords (Phase 2, 2026-10-05)
-- ============================================================
-- signal_decision_snapshots: the INPUT snapshot a decision was taken from —
--   built on the first poll after a decision bar (T) closes, and on any
--   later poll of that bar where a structure limit fills on the live spot; inputs only (OHLCV window, futures quote, compressed option
--   chain, OI / PCR / IV / HV, corporate actions), per-input data quality
--   (asOf, ageMs, source, status) and every version. Never updated (rule
--   below); replay(snapshotId) reads nothing else.
-- decision_records: the DecisionRecord derived from one snapshot (events,
--   trigger candidates, parents, metrics, option candidates, arbitration,
--   final status) — immutable; only the later `outcome` columns are written.
-- decision_trigger_events: which events each trigger candidate used — a
--   separate, insert-only association written after event evaluation.
-- snapshot_id on setup_events and signals: the snapshot a row was decided
--   from (a logical reference, not a constraint: those rows are written
--   fire-and-forget and must never fail because a snapshot write did).
--
-- NOT the same as decision_snapshots (006), the existing per-decision
-- TAKE / REFUSE record — that table is untouched.
--
-- Additive and idempotent: every statement is IF NOT EXISTS / OR REPLACE,
-- nothing existing is renamed, altered in type or deleted. Each DDL statement
-- is atomic on its own; the boot runner (ensure-capture-schema.ts) applies
-- them one by one, so no multi-statement transaction is used.
-- ============================================================

CREATE TABLE IF NOT EXISTS signal_decision_snapshots (
  snapshot_id UUID PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  mode VARCHAR(20) NOT NULL,
  -- T: the close of the newest closed decision bar (exchange calendar).
  decision_bar_time TIMESTAMPTZ NOT NULL,
  -- When the poll that built the snapshot ran (after T); the decision clock of the record.
  polled_at TIMESTAMPTZ NOT NULL,
  -- NEW_BAR (first poll after T closed) | SPOT_FILL (a later poll of the bar where a limit filled).
  capture_reason VARCHAR(20) NOT NULL,
  snapshot_schema_version VARCHAR(40) NOT NULL,
  versions JSONB NOT NULL,
  data_quality JSONB NOT NULL,
  -- The frozen inputs; the option chain inside is gzip+base64 compressed.
  inputs JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one snapshot per symbol / mode / poll.
CREATE UNIQUE INDEX IF NOT EXISTS uq_signal_decision_snapshots_poll ON signal_decision_snapshots (exchange, symbol, mode, decision_bar_time, polled_at);
CREATE INDEX IF NOT EXISTS idx_signal_decision_snapshots_symbol_bar ON signal_decision_snapshots (symbol, decision_bar_time DESC);

-- Immutable: an UPDATE of a snapshot does nothing.
CREATE OR REPLACE RULE signal_decision_snapshots_immutable AS ON UPDATE TO signal_decision_snapshots DO INSTEAD NOTHING;

CREATE TABLE IF NOT EXISTS decision_records (
  snapshot_id UUID PRIMARY KEY REFERENCES signal_decision_snapshots (snapshot_id),
  record_schema_version VARCHAR(40) NOT NULL,
  -- The canonical DecisionRecord (deterministic; replay must reproduce it exactly).
  record JSONB NOT NULL,
  -- sha256 of the canonical record text.
  record_hash CHAR(64) NOT NULL,
  final_status VARCHAR(40) NOT NULL,
  selected_candidate_id VARCHAR(160),
  -- Written later (grading); never part of the replayed record.
  outcome JSONB,
  outcome_at TIMESTAMPTZ,
  -- Generated timestamp (declared nondeterministic).
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decision_records_selected ON decision_records (selected_candidate_id) WHERE selected_candidate_id IS NOT NULL;

-- The record itself is immutable: an UPDATE that would change it does nothing (outcome may still be written).
CREATE OR REPLACE RULE decision_records_immutable AS ON UPDATE TO decision_records
  WHERE OLD.record IS DISTINCT FROM NEW.record OR OLD.record_hash IS DISTINCT FROM NEW.record_hash OR OLD.final_status IS DISTINCT FROM NEW.final_status OR OLD.selected_candidate_id IS DISTINCT FROM NEW.selected_candidate_id
  DO INSTEAD NOTHING;

CREATE TABLE IF NOT EXISTS decision_trigger_events (
  snapshot_id UUID NOT NULL REFERENCES signal_decision_snapshots (snapshot_id),
  candidate_id VARCHAR(160) NOT NULL,
  event_id VARCHAR(200) NOT NULL,
  ordinal SMALLINT NOT NULL,
  PRIMARY KEY (snapshot_id, candidate_id, event_id)
);

-- Insert-only.
CREATE OR REPLACE RULE decision_trigger_events_immutable AS ON UPDATE TO decision_trigger_events DO INSTEAD NOTHING;

ALTER TABLE setup_events ADD COLUMN IF NOT EXISTS snapshot_id UUID;
CREATE INDEX IF NOT EXISTS idx_setup_events_snapshot ON setup_events (snapshot_id) WHERE snapshot_id IS NOT NULL;

ALTER TABLE signals ADD COLUMN IF NOT EXISTS snapshot_id UUID;
CREATE INDEX IF NOT EXISTS idx_signals_snapshot ON signals (snapshot_id) WHERE snapshot_id IS NOT NULL;
