-- ============================================================
-- LOGIC VERSION STAMP (validation review)
-- ============================================================
-- The validation review changed live rules behind flags (structural stop,
-- location gate, room gate, concurrency cap, closing guard, rich-IV R:R).
-- A decision made under one rule set must never be pooled with one made under
-- another, so every decision now records the logic version and the flag set
-- that was live when it was made (apps/server/src/config/trading-flags.ts).
--
--   logic_version  LOGIC_VERSION at decision time. NULL = recorded before
--                  stamping existed, i.e. the pre-review engine.
--   logic_flags    { flags: {...}, params: {...} } — every switch and tunable.
--
-- The same stamp is written to signals.inputs.logic for every generated setup
-- (JSONB, no DDL needed).
--
-- Additive and idempotent: safe to run on every boot (ensure-capture-schema.ts).
-- ============================================================

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS logic_version VARCHAR(64);
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS logic_flags JSONB;

CREATE INDEX IF NOT EXISTS idx_decision_logic_version ON decision_snapshots(logic_version, time DESC);
