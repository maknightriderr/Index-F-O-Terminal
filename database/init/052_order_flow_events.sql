-- Dhan order-flow engine v2, phase 1 (7 Nov 2026): data integrity and recording for replay.
--   order_flow_bars gains the bar's UNRECONCILED volume (volume the feed reported between packets that no observed
--   trade explains: never given a price or a side), and the tick size / price-row step it was bucketed with.
--   order_flow_events keeps each closed 15-minute bar's normalized trade events (compressed), so footprint / CVD
--   setups can be replayed later; a historical footprint cannot be rebuilt from candles. Trimmed nightly
--   (maintenance.ts, FLOW_EVENT_RETENTION_DAYS). Every statement is idempotent.
ALTER TABLE IF EXISTS order_flow_bars ADD COLUMN IF NOT EXISTS unreconciled_volume NUMERIC;
ALTER TABLE IF EXISTS order_flow_bars ADD COLUMN IF NOT EXISTS tick_size NUMERIC;
ALTER TABLE IF EXISTS order_flow_bars ADD COLUMN IF NOT EXISTS price_step NUMERIC;

CREATE TABLE IF NOT EXISTS order_flow_events (
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  instrument VARCHAR(80),
  bar_time TIMESTAMPTZ NOT NULL,
  bar_ms INTEGER NOT NULL,
  trades INTEGER NOT NULL,
  unreconciled_volume NUMERIC NOT NULL DEFAULT 0,
  -- How `events` is encoded, e.g. 'gzip-json-v1': gzip of a JSON array of [msFromBarStart, price, qty, side]
  -- (side 1 = BUY, -1 = SELL, 0 = UNKNOWN, 9 = UNRECONCILED with price null).
  encoding VARCHAR(20) NOT NULL,
  events BYTEA NOT NULL,
  version VARCHAR(20) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (symbol, exchange, bar_time)
);
CREATE INDEX IF NOT EXISTS idx_order_flow_events_bar_time ON order_flow_events (bar_time);
