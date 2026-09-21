-- ============================================================
-- RETENTION AND COMPRESSION FOR THE CAPTURE TABLES (BEST-EFFORT)
-- ============================================================
-- Applied statement-by-statement by apps/server/src/database/migrate.ts,
-- which logs and skips anything that fails — so this file is a no-op on a
-- plain managed Postgres without the timescaledb extension, and the
-- capture still works there, just without automatic pruning.
--
-- On a plain Postgres the pruning falls to the capture service itself,
-- which deletes past its own horizon on a schedule. Both paths exist
-- because the production database is Railway's plain Postgres plugin on a
-- 5 GB volume, and that volume has already been filled once.
-- ============================================================

-- Chain snapshots are the bulk of the capture. A year of them is under a
-- gigabyte uncompressed, and compression after a week cuts the settled
-- history hard, because a chain's rows differ from one another mostly in
-- the strike and a few decimals.
ALTER TABLE oi_snapshots SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol, expiry, option_type',
  timescaledb.compress_orderby = 'time DESC, strike'
);
SELECT add_compression_policy('oi_snapshots', INTERVAL '7 days', if_not_exists => true);
SELECT add_retention_policy('oi_snapshots', INTERVAL '400 days', if_not_exists => true);

ALTER TABLE futures_snapshots SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol, expiry',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('futures_snapshots', INTERVAL '7 days', if_not_exists => true);
SELECT add_retention_policy('futures_snapshots', INTERVAL '400 days', if_not_exists => true);

ALTER TABLE pcr_history SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('pcr_history', INTERVAL '7 days', if_not_exists => true);
SELECT add_retention_policy('pcr_history', INTERVAL '400 days', if_not_exists => true);

-- Underlying observations are small per row but the most frequent.
-- 003_timescale.sql set this to 30 days back when nothing wrote to the table
-- and it was only ever going to hold raw websocket ticks. It is now the
-- underlying half of the replay record, and 30 days of history cannot support
-- an out-of-sample test. add_retention_policy with if_not_exists is a no-op
-- against an existing policy, so the old one has to be removed first.
SELECT remove_retention_policy('market_ticks', if_exists => true);
SELECT add_retention_policy('market_ticks', INTERVAL '400 days', if_not_exists => true);

-- Decision snapshots are the research record and the smallest table of the
-- set — a few hundred rows a day at most. It is deliberately NOT a
-- hypertable and has no retention policy: these are the observations every
-- future promotion decision depends on, and losing the old ones would mean
-- losing the out-of-sample evidence the moment it became valuable.
SELECT add_retention_policy('data_quality_events', INTERVAL '90 days', if_not_exists => true);
