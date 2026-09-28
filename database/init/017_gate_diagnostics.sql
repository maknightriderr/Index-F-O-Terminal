-- ============================================================
-- GATE DIAGNOSTICS (Phase 1 — observation only)
-- ============================================================
-- The live gate chain in resolveStickyTradeSetup is a strict first-match
-- chain: the first gate that refuses is the only one anyone ever sees. That
-- makes the question "which gates would ALSO have refused this?" — the one
-- a loss review actually needs — unanswerable.
--
-- Each row here is ONE gate evaluated INDEPENDENTLY for ONE recorded
-- decision. The evaluation is computed from inputs already in scope after
-- the live refusal was decided, and it is never read back by the engine:
-- the live chain is unchanged and these rows cannot alter it.
--
-- status:
--   PASS           the gate would have let this through
--   FAIL           the gate would have refused this
--   NOT_EVALUATED  the gate's input was not available (e.g. the reliability
--                  check is skipped by the live chain while RISK_OFF holds)
--
-- SIGNAL_STALE rows are written against the ORIGINAL decision (the TAKE
-- that minted the sticky setup) when that setup is later re-surfaced after
-- the underlying moved beyond the staleness threshold.
-- ============================================================

CREATE TABLE IF NOT EXISTS gate_diagnostics (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  decision_id UUID NOT NULL REFERENCES decision_snapshots(decision_id) ON DELETE CASCADE,
  gate VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('PASS', 'FAIL', 'NOT_EVALUATED')),
  reason TEXT,
  threshold JSONB,
  input_values JSONB NOT NULL DEFAULT '{}',
  -- True for the one gate the live first-match chain actually refused on.
  -- Lets a report separate "the gate that decided" from "gates that would
  -- also have refused" without re-deriving the chain order.
  was_deciding_gate BOOLEAN NOT NULL DEFAULT FALSE,
  evaluated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gate_diag_decision ON gate_diagnostics(decision_id);
CREATE INDEX IF NOT EXISTS idx_gate_diag_gate ON gate_diagnostics(gate, status, evaluated_at DESC);

-- The signals row (Backtesting) a TAKE decision minted, so a decision's
-- eventual simulated close can be joined back to it. Null on refusals and on
-- decisions recorded before this column existed.
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS signal_id UUID;
CREATE INDEX IF NOT EXISTS idx_decision_signal ON decision_snapshots(signal_id) WHERE signal_id IS NOT NULL;
