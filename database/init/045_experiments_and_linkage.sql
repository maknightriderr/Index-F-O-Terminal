-- ============================================================
-- 045 — Durable decision-to-trade linkage + isolated paper experiments (2026-10-23)
-- ============================================================
-- 1. slot_decisions.signal_id / decision_id: the trade row a MINTED slot
--    evaluation produced, written by the evaluation itself. A MINTED row
--    without a trade row can no longer be inferred from time windows, and a
--    signal can be linked to at most one MINTED evaluation (unique index).
-- 2. Isolated paper experiments (EXP-2.0, services/experiment-engine.ts).
--    Each arm holds its own positions, slots, cooldowns and exits. Nothing
--    here is read by the production baseline, and nothing here is executed
--    with a broker. experiment_arms records the actual activation instant of
--    every arm version the first time it starts.
-- ============================================================

ALTER TABLE slot_decisions ADD COLUMN IF NOT EXISTS signal_id UUID;
ALTER TABLE slot_decisions ADD COLUMN IF NOT EXISTS decision_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_decisions_signal ON slot_decisions (signal_id) WHERE signal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS experiment_arms (
  arm            VARCHAR(8)  NOT NULL,
  version        VARCHAR(40) NOT NULL,
  kind           VARCHAR(20) NOT NULL,   -- CONTROL_REPLICA | FILTER_CONTROL | HYPOTHESIS
  exploratory    BOOLEAN     NOT NULL DEFAULT FALSE,
  definition     JSONB       NOT NULL,
  activated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  commit         VARCHAR(40),
  PRIMARY KEY (arm, version)
);

CREATE TABLE IF NOT EXISTS experiment_positions (
  id               UUID        PRIMARY KEY,
  arm              VARCHAR(8)  NOT NULL,
  arm_version      VARCHAR(40) NOT NULL,
  candidate_id     VARCHAR(120) NOT NULL,
  symbol           VARCHAR(50) NOT NULL,
  exchange         VARCHAR(10) NOT NULL,
  mode             VARCHAR(12) NOT NULL,
  direction        VARCHAR(10) NOT NULL,
  opened_at        TIMESTAMPTZ NOT NULL,
  official_status  VARCHAR(12) NOT NULL,  -- OPEN | CLOSED
  sim_status       VARCHAR(16) NOT NULL,  -- NOT_OPENED | OPEN | EXIT_PENDING | CLOSED | UNRESOLVED
  official_net_r   NUMERIC,
  sim_net_r        NUMERIC,
  state            JSONB       NOT NULL,  -- the full position (contract, levels, both ledgers, reasons)
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (arm, arm_version, candidate_id, opened_at)
);
CREATE INDEX IF NOT EXISTS idx_exp_positions_live ON experiment_positions (official_status, sim_status);
CREATE INDEX IF NOT EXISTS idx_exp_positions_arm ON experiment_positions (arm, opened_at);

CREATE TABLE IF NOT EXISTS experiment_events (
  id           BIGSERIAL   PRIMARY KEY,
  position_id  UUID        NOT NULL,
  at           TIMESTAMPTZ NOT NULL,
  event        VARCHAR(32) NOT NULL,
  detail       JSONB       NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_exp_events_position ON experiment_events (position_id, at);

CREATE TABLE IF NOT EXISTS experiment_decisions (
  id            BIGSERIAL    PRIMARY KEY,
  at            TIMESTAMPTZ  NOT NULL,
  arm           VARCHAR(8)   NOT NULL,
  arm_version   VARCHAR(40)  NOT NULL,
  candidate_id  VARCHAR(120) NOT NULL,
  symbol        VARCHAR(50)  NOT NULL,
  exchange      VARCHAR(10)  NOT NULL,
  mode          VARCHAR(12)  NOT NULL,
  decision      VARCHAR(8)   NOT NULL,   -- TAKE | SKIP
  code          VARCHAR(40),
  detail        JSONB,
  UNIQUE (arm, arm_version, candidate_id, decision, code)
);
CREATE INDEX IF NOT EXISTS idx_exp_decisions_at ON experiment_decisions (at);
