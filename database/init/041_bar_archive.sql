-- ============================================================
-- 041 — Bar archive: persisted 15-minute and daily bars (2026-10-15)
-- ============================================================
-- Research only: nothing in the decision path reads this table.
--
-- The 2026-10-15 audit found no stored price history (the `ohlcv` table was
-- never written), so every strategy could only be judged on a few weeks of
-- forward paper trades. The bar-archive job (services/bar-archive.ts) writes,
-- once each day's sessions are over and no exchange is trading, the closed
-- 15-minute and daily bars of every symbol the engines evaluated that day plus
-- the main indices, from the broker's own history endpoint.
--
-- One row per (symbol, exchange, interval, bar_time); a re-run inserts nothing
-- twice (ON CONFLICT DO NOTHING). `token` is the instrument the bars came from:
-- the spot / index token on NSE and BSE, the nearest futures contract on MCX
-- (it rolls monthly, so it is recorded with every bar).
-- ============================================================

CREATE TABLE IF NOT EXISTS bar_archive (
  symbol       VARCHAR(50)  NOT NULL,
  exchange     VARCHAR(10)  NOT NULL,
  interval     VARCHAR(16)  NOT NULL,
  bar_time     TIMESTAMPTZ  NOT NULL,
  token        VARCHAR(30),
  open         NUMERIC      NOT NULL,
  high         NUMERIC      NOT NULL,
  low          NUMERIC      NOT NULL,
  close        NUMERIC      NOT NULL,
  volume       NUMERIC,
  source       VARCHAR(20)  NOT NULL DEFAULT 'BROKER_HISTORY',
  archived_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (symbol, exchange, interval, bar_time)
);

CREATE INDEX IF NOT EXISTS idx_bar_archive_time ON bar_archive (bar_time);
