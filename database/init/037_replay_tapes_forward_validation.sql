-- ============================================================
-- 037 — Full replay tapes, slot decisions, forward outcomes (2026-10-05)
-- ============================================================
-- decision_tapes: for a snapshotted poll, every external read the decision
--   path made (Redis, SQL, broker, in-process state) with its result — the
--   I/O tape. replay(snapshotId, full) re-runs the unchanged decision code
--   with those boundaries served only from the tape (no network, no
--   writes), then compares with the live result kept beside it. Tapes are
--   bulky, so they are kept DECISION_TAPE_RETENTION_DAYS (default 7) and
--   then removed by the forward-validation job — the snapshot and the
--   DecisionRecord stay.
-- slot_decisions: one row per snapshotted poll — what the slot did (minted /
--   NO TRADE / no candidate / held), how far the ranking had to fall
--   through, the limiting factor and the NO TRADE diagnostics.
-- forward_outcomes: predicted vs actual, graded after the fact from later
--   snapshots and closed paper trades — evidence-count ranking (ARB-2.0),
--   theta-adjusted targets (OPTION-2.0), strike selection (OPTSEL-2.0).
--   Measurement only: nothing in the decision path reads it.
--
-- Additive and idempotent (IF NOT EXISTS); one atomic statement each.
-- ============================================================

CREATE TABLE IF NOT EXISTS decision_tapes (
  snapshot_id UUID PRIMARY KEY REFERENCES signal_decision_snapshots (snapshot_id),
  tape_version VARCHAR(20) NOT NULL,
  -- gzip + base64 of the tape entries.
  tape_gz TEXT NOT NULL,
  entries INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  -- gzip + base64 of the live MarketBiasResult the poll returned.
  live_result_gz TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decision_tapes_created ON decision_tapes (created_at);

CREATE TABLE IF NOT EXISTS slot_decisions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  time TIMESTAMPTZ NOT NULL,
  snapshot_id UUID,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  mode VARCHAR(20) NOT NULL,
  decision_bar_time TIMESTAMPTZ,
  -- MINTED | NO_TRADE (candidates, all failed) | NO_CANDIDATE | HELD (a trade was already open)
  outcome VARCHAR(20) NOT NULL,
  candidates INTEGER NOT NULL DEFAULT 0,
  -- Ranked candidates above the minted one that failed their final check.
  fellthrough INTEGER NOT NULL DEFAULT 0,
  -- Candidates that failed the pre-mint check / the mint itself.
  pre_mint_failures INTEGER NOT NULL DEFAULT 0,
  selected_source VARCHAR(40),
  selected_candidate_id VARCHAR(160),
  limiting_stage VARCHAR(40),
  limiting_code VARCHAR(40),
  diagnostics JSONB,
  option_version VARCHAR(20),
  arbitration_version VARCHAR(20),
  option_selection_version VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slot_decisions_symbol_time ON slot_decisions (symbol, time DESC);
CREATE INDEX IF NOT EXISTS idx_slot_decisions_outcome_time ON slot_decisions (outcome, time DESC);
CREATE INDEX IF NOT EXISTS idx_slot_decisions_snapshot ON slot_decisions (snapshot_id) WHERE snapshot_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS forward_outcomes (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  -- OPTION_PAYOFF | STRIKE_SELECTION | EVIDENCE_RANK
  kind VARCHAR(30) NOT NULL,
  subject_id VARCHAR(200) NOT NULL,
  snapshot_id UUID,
  signal_id UUID,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  versions JSONB NOT NULL,
  predicted JSONB NOT NULL,
  actual JSONB NOT NULL,
  graded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_forward_outcomes_subject ON forward_outcomes (kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_forward_outcomes_kind_time ON forward_outcomes (kind, decided_at DESC);
