-- ============================================================
-- 042 — Config registry (audit 2026-10-18, REPL-1)
-- ============================================================
-- Measurement only: nothing in the decision path reads this table.
--
-- A snapshot replay refuses (CONFIG_MISMATCH) when the running configuration
-- is not the one the snapshot recorded, and until now nothing said what the
-- recorded configuration WAS: only its hash survived. Every configuration the
-- engine snapshots under is written here once per process: the hash, the
-- decision config, the full logic stamp (flags and parameters) and the git
-- commit, so a refused replay can name the commit and settings to replay it
-- under.
--
-- first_seen is the first process that used the hash, last_seen the latest
-- process start that used it (it is upserted once per process, not per poll).
-- ============================================================

CREATE TABLE IF NOT EXISTS config_registry (
  config_hash      TEXT        PRIMARY KEY,
  logic_flags_hash TEXT,
  config           JSONB       NOT NULL,
  logic_stamp      JSONB       NOT NULL,
  git_commit       TEXT,
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
