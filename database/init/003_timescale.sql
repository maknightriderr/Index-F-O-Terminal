-- ============================================================
-- TIMESCALEDB UPGRADES (BEST-EFFORT)
-- ============================================================
-- Upgrades the plain tables from 002_schema.sql into hypertables
-- with compression/retention policies, and adds the continuous
-- aggregate. Every statement here depends on the `timescaledb`
-- extension actually being installed on the Postgres server.
--
-- This file is applied by apps/server/src/database/migrate.ts
-- STATEMENT-BY-STATEMENT, catching and logging (not failing) on
-- any statement whose error message indicates the extension is
-- unavailable — so the exact same schema files work unmodified
-- against both a real TimescaleDB instance (local Docker, or a
-- managed TimescaleDB host) and a plain managed Postgres (e.g.
-- Railway's Postgres plugin), just with fewer optimizations on
-- the latter.
-- ============================================================

SELECT create_hypertable('market_ticks', 'time', if_not_exists => true);
SELECT add_retention_policy('market_ticks', INTERVAL '30 days', if_not_exists => true);

SELECT create_hypertable('ohlcv', 'time', if_not_exists => true);

ALTER TABLE ohlcv SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'token, exchange, interval',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('ohlcv', INTERVAL '7 days', if_not_exists => true);

SELECT create_hypertable('oi_snapshots', 'time', if_not_exists => true);

SELECT create_hypertable('futures_snapshots', 'time', if_not_exists => true);

SELECT create_hypertable('iv_history', 'time', if_not_exists => true);

SELECT create_hypertable('pcr_history', 'time', if_not_exists => true);

SELECT create_hypertable('system_health', 'time', if_not_exists => true);
SELECT add_retention_policy('system_health', INTERVAL '7 days', if_not_exists => true);

-- 1-minute OHLCV aggregation from raw ticks
CREATE MATERIALIZED VIEW IF NOT EXISTS ohlcv_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time) AS bucket,
  token,
  exchange,
  first(ltp, time) AS open_price,
  max(ltp) AS high,
  min(ltp) AS low,
  last(ltp, time) AS close_price,
  max(volume) - min(volume) AS volume
FROM market_ticks
GROUP BY bucket, token, exchange
WITH NO DATA;

-- Refresh policy: keep updated within 10 minutes
SELECT add_continuous_aggregate_policy('ohlcv_1m',
  start_offset => INTERVAL '1 hour',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => true
);
