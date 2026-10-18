-- ============================================================
-- 043 — OI snapshot storage (audit 2026-10-18, OPS-1)
-- ============================================================
-- oi_snapshots is the largest table (683 MB for 21 Sep - 16 Oct, about 36 MB
-- per session on a 4.4 GB volume that filled once already, 17 Sep).
--
-- 1. Four of its indexes had 0 scans in a month of production use (stats
--    since 17 Sep): idx_oi_strike (61 MB), idx_oi_symbol (11 MB),
--    idx_oi_greeks_model (9.7 MB), idx_oi_capture_run (9 MB). Every capture
--    insert maintained them. Every reader filters on time, or on symbol +
--    expiry + time (idx_oi_snapshots_capture, kept). Dropped. To restore one:
--      CREATE INDEX idx_oi_strike ON oi_snapshots(symbol, strike, option_type, time DESC)
--    (the definitions were in 002_schema.sql and 010_capture_quality_lineage.sql).
--
-- 2. oi_snapshots_archive: market-state-capture.ts packs each IST day of one
--    symbol older than OI_RETENTION_DAYS (default 60) into one gzip'd JSON
--    row here (lossless: every column of every row), and only then deletes
--    those raw rows. One row per (day, exchange, symbol).
-- ============================================================

DROP INDEX IF EXISTS idx_oi_strike;
DROP INDEX IF EXISTS idx_oi_symbol;
DROP INDEX IF EXISTS idx_oi_greeks_model;
DROP INDEX IF EXISTS idx_oi_capture_run;

CREATE TABLE IF NOT EXISTS oi_snapshots_archive (
  day          DATE        NOT NULL,
  exchange     VARCHAR(10) NOT NULL,
  symbol       VARCHAR(50) NOT NULL,
  rows         INTEGER     NOT NULL,
  first_time   TIMESTAMPTZ NOT NULL,
  last_time    TIMESTAMPTZ NOT NULL,
  bytes        INTEGER     NOT NULL,
  payload_gz   TEXT        NOT NULL,
  archived_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, exchange, symbol)
);
